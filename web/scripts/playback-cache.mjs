import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const PLAYBACK_VERSION = "2";
// Selection changes need new URLs; unchanged encoding can reuse existing bytes.
const ENCODE_VERSION = "1";
const MAX_SOURCE_BITRATE = 2_200_000;
const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;
const ENCODE_TIMEOUT_MS = 120_000;
const SCALE = "scale=w='min(iw,if(gte(iw,ih),1280,720))':h='min(ih,if(gte(iw,ih),720,1280))':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos";

export function playbackCachePath(cacheDir, sourcePath, sourceStats) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([path.resolve(sourcePath), sourceStats.size, sourceStats.mtimeMs]))
    .digest("hex").slice(0, 32);
  return path.join(cacheDir, `playback-v${ENCODE_VERSION}-${fingerprint}.mp4`);
}

export async function preparePlayback(sourcePath, outputPath, { runEncode = (task) => task() } = {}) {
  if (path.resolve(sourcePath) === path.resolve(outputPath)) {
    throw new Error("A playback copy must not replace its source");
  }
  if (await hasCompletedFile(outputPath)) return outputPath;

  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries",
    "stream=index,codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,color_transfer:stream_disposition=attached_pic:format=format_name,bit_rate,size,duration",
    "-of", "json", sourcePath,
  ], PROBE_TIMEOUT_MS);
  const { streams, format } = JSON.parse(stdout);
  const video = streams?.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video || !(video.width > 0 && video.height > 0)) {
    throw new Error("The archive file has no playable video stream");
  }
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const hdr = ["arib-std-b67", "smpte2084"].includes(video.color_transfer);
  const mp4 = String(format?.format_name || "").split(",").some((name) => name === "mov" || name === "mp4");
  if (mp4 && video.codec_name === "h264" && video.pix_fmt === "yuv420p" && !hdr
    && (!audio || audio.codec_name === "aac") && totalBitrate(format) <= MAX_SOURCE_BITRATE) return sourcePath;

  // Probing compatible originals must never wait behind a video conversion.
  return runEncode(async () => {
    if (await hasCompletedFile(outputPath)) return outputPath;
    await mkdir(path.dirname(outputPath), { recursive: true });
    const tempPath = `${outputPath}.part-${process.pid}-${randomUUID()}`;
    const filters = [SCALE];
    if (hdr) {
      filters.push(
        "zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709",
        "tonemap=tonemap=mobius:desat=2", "zscale=t=bt709:m=bt709:r=limited",
      );
    }
    const fps = Math.min(30, frameRate(video.avg_frame_rate) || frameRate(video.r_frame_rate) || 30);
    filters.push("format=yuv420p", "setsar=1", `fps=${fps}`);
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-filter_threads", "2",
      "-i", sourcePath, "-map", `0:${video.index}`, "-map", "0:a:0?",
      "-vf", filters.join(","), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-maxrate", "1800k", "-bufsize", "3600k", "-threads", "2", "-pix_fmt", "yuv420p",
      "-profile:v", "high", "-level:v", "3.1", "-g", "60",
      "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000",
    ];
    if (hdr) args.push("-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709");
    args.push("-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", tempPath);
    try {
      await run("ffmpeg", args, ENCODE_TIMEOUT_MS);
      if (!await hasCompletedFile(tempPath)) throw new Error("Playback conversion returned an empty file");
      await rename(tempPath, outputPath);
      return outputPath;
    } finally {
      await rm(tempPath, { force: true });
    }
  });
}

async function hasCompletedFile(filePath) {
  try {
    const file = await stat(filePath);
    return file.isFile() && file.size > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function frameRate(value) {
  const [numerator, denominator = 1] = String(value || "").split("/").map(Number);
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function totalBitrate(format) {
  const measured = Number(format?.bit_rate);
  if (Number.isFinite(measured) && measured > 0) return measured;
  const estimated = Number(format?.size) * 8 / Number(format?.duration);
  return Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
}

async function run(command, args, timeout) {
  try {
    return await execFileAsync(command, args, {
      encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
  } catch (cause) {
    throw new Error(command === "ffprobe" ? "Playback metadata could not be read" : "Playback conversion failed", { cause });
  }
}
