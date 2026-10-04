import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PLAYBACK_VERSION, playbackCachePath, preparePlayback } from "../scripts/playback-cache.mjs";

const execFileAsync = promisify(execFile);

test("playback keys retain encoding version one while the public policy advances", () => {
  const stats = { size: 100, mtimeMs: 200 };
  const output = playbackCachePath("/cache", "/archive/video.mp4", stats);
  assert.equal(PLAYBACK_VERSION, "2");
  assert.match(path.basename(output), /^playback-v1-[a-f0-9]{32}\.mp4$/);
  assert.equal(output, playbackCachePath("/cache", "/archive/video.mp4", stats));
  assert.notEqual(output, playbackCachePath("/cache", "/archive/other.mp4", stats));
  assert.notEqual(output, playbackCachePath("/cache", "/archive/video.mp4", { ...stats, size: 101 }));
  assert.notEqual(output, playbackCachePath("/cache", "/archive/video.mp4", { ...stats, mtimeMs: 201 }));
});

test("compatible H264 with AAC or no audio bypasses the encode queue and stays untouched", async (context) => {
  const directory = await fixtureDirectory(context);
  for (const audio of [true, false]) {
    const source = await createVideo(directory, `compatible-${audio}.mp4`, { codec: "libx264", audio });
    const original = await readFile(source);
    const output = playbackCachePath(directory, source, await stat(source));
    assert.equal(await preparePlayback(source, output, {
      runEncode() { assert.fail("Compatible videos must not enter the encode queue"); },
    }), source);
    assert.deepEqual(await readFile(source), original);
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
});

test("HEVC becomes a reusable faststart H264 copy without upscaling or changing its source", async (context) => {
  const directory = await fixtureDirectory(context);
  const source = await createVideo(directory, "hevc.mp4", { audio: true, rate: 60 });
  const original = await readFile(source);
  const originalStats = await stat(source);
  const output = playbackCachePath(path.join(directory, "cache"), source, originalStats);
  let encodes = 0;
  const options = { runEncode: async (task) => { encodes += 1; return task(); } };
  assert.equal(await preparePlayback(source, output, options), output);
  const encodedStats = await stat(output);
  const info = await probe(output);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(video.width, 160);
  assert.equal(video.height, 96);
  assert.equal(video.r_frame_rate, "30/1");
  assert.equal(info.streams.find((stream) => stream.codec_type === "audio").codec_name, "aac");
  assertFaststart(await readFile(output));
  await decode(output);
  assert.equal(await preparePlayback(source, output, options), output);
  assert.equal(encodes, 1);
  assert.equal((await stat(output)).mtimeMs, encodedStats.mtimeMs);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await stat(source)).mtimeMs, originalStats.mtimeMs);
  assert.deepEqual(await readdir(path.dirname(output)), [path.basename(output)]);
  await assert.rejects(preparePlayback(source, source), /must not replace its source/);
});

test("high-bitrate H264 receives a smaller decodable copy while preserving the original", async (context) => {
  const directory = await fixtureDirectory(context);
  const source = await createVideo(directory, "high-bitrate.mp4", {
    codec: "libx264", audio: true, size: "1280x720", duration: 1.2, crf: 10,
  });
  const original = await readFile(source);
  const before = await stat(source);
  const sourceInfo = await probe(source);
  assert.equal(sourceInfo.streams[0].codec_name, "h264");
  assert.equal(sourceInfo.streams[0].pix_fmt, "yuv420p");
  assert.ok(Number(sourceInfo.format.bit_rate) > 2_200_000);
  const output = playbackCachePath(directory, source, before);
  assert.equal(await preparePlayback(source, output), output);
  const result = await readFile(output);
  assert.ok(result.length < original.length * 0.75, "The playback copy must reduce transfer size");
  assert.equal((await probe(output)).streams[0].codec_name, "h264");
  assertFaststart(result);
  await decode(output);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await stat(source)).mtimeMs, before.mtimeMs);
});

test("large portrait and landscape copies fit the playback dimensions with even edges", async (context) => {
  const directory = await fixtureDirectory(context);
  for (const [size, expected] of [["1920x1080", [1280, 720]], ["1080x1920", [720, 1280]]]) {
    const source = await createVideo(directory, `${size}.mp4`, { size, duration: 0.08 });
    const output = playbackCachePath(directory, source, await stat(source));
    await preparePlayback(source, output);
    const video = (await probe(output)).streams[0];
    assert.deepEqual([video.width, video.height], expected);
  }
});

test("H264 and AAC inside Matroska still receive an MP4 playback copy", async (context) => {
  const directory = await fixtureDirectory(context);
  const source = await createVideo(directory, "matroska.mkv", { codec: "libx264", audio: true });
  const output = playbackCachePath(directory, source, await stat(source));
  assert.equal(await preparePlayback(source, output), output);
  const info = await probe(output);
  assert.equal(info.streams[0].codec_name, "h264");
  assertFaststart(await readFile(output));
  await decode(output);
});

test("HLG and PQ videos produce decodable SDR copies with BT709 color metadata", async (context) => {
  const directory = await fixtureDirectory(context);
  for (const transfer of ["arib-std-b67", "smpte2084"]) {
    const source = await createVideo(directory, `${transfer}.mp4`, { transfer });
    const output = playbackCachePath(directory, source, await stat(source));
    await preparePlayback(source, output);
    const video = (await probe(output)).streams[0];
    assert.equal(video.codec_name, "h264");
    assert.equal(video.pix_fmt, "yuv420p");
    assert.equal(video.color_transfer, "bt709");
    assert.equal(video.color_primaries, "bt709");
    assert.equal(video.color_space, "bt709");
    await decode(output);
  }
});

test("a failed conversion never leaves a completed or temporary playback file", async (context) => {
  const directory = await fixtureDirectory(context);
  const source = await createVideo(directory, "failed.mp4");
  const output = playbackCachePath(directory, source, await stat(source));
  await assert.rejects(preparePlayback(source, output, {
    runEncode: async (task) => { await rm(source); return task(); },
  }), /Playback conversion failed/);
  assert.deepEqual(await readdir(directory), []);
});

async function fixtureDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rewind-playback-cache-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createVideo(directory, name, {
  codec = "libx265", audio = false, rate = 30, size = "160x96", duration = 0.3, transfer = "", crf,
} = {}) {
  const output = path.join(directory, name);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}`];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-c:a", "aac");
  args.push("-t", String(duration), "-c:v", codec, "-preset", "ultrafast", "-threads", "2", "-filter_threads", "2");
  if (crf !== undefined) args.push("-crf", String(crf));
  if (codec === "libx265") {
    const color = transfer ? `:colorprim=9:transfer=${transfer === "arib-std-b67" ? 18 : 16}:colormatrix=9` : "";
    args.push("-x265-params", `pools=1:frame-threads=1:log-level=error${color}`);
  }
  args.push("-pix_fmt", transfer ? "yuv420p10le" : "yuv420p");
  if (transfer) args.push("-color_trc", transfer, "-colorspace", "bt2020nc", "-color_primaries", "bt2020");
  args.push(output);
  await execFileAsync("ffmpeg", args, { timeout: 30_000 });
  return output;
}

async function probe(filePath) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath]);
  return JSON.parse(stdout);
}

async function decode(filePath) {
  const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "2", "-i", filePath, "-f", "null", "-"], { timeout: 30_000 });
  assert.equal(stderr, "");
}

function assertFaststart(bytes) {
  const atoms = [];
  for (let offset = 0; offset < bytes.length;) {
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const shortSize = bytes.readUInt32BE(offset);
    const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : shortSize;
    assert.ok(size >= 8);
    atoms.push(type);
    offset += size;
  }
  assert.ok(atoms.indexOf("moov") >= 0);
  assert.ok(atoms.indexOf("moov") < atoms.indexOf("mdat"));
}
