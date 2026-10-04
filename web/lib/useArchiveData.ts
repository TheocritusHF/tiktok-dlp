"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bookmarkedVideoPageParams, boundedVideoPageLimit, mergeVideoPage } from "./archive-data-state.mjs";
import { fetchJson } from "./json-request.mjs";
import type { ArchiveStats, Creator, FeedPage, SavedVideo } from "./types";

export type ArchiveDataSource = "mock" | "loading" | "refreshing" | "live" | "error";

const emptyStats: ArchiveStats = {
  creatorCount: 0,
  videoCount: 0,
  storageUsed: "0 B",
  storagePercent: 0,
  newThisWeek: 0,
};
const VIDEO_PAGE_RETRY_DELAY_MS = 10_000;

export function useArchiveData({
  fallbackCreators,
  fallbackVideos,
  fallbackStats,
  videoCreatorId = "",
  videoUsername = "",
  videoFileId = "",
  videoLimit,
  paginateVideos = false,
  includeVideos = true,
  includeStats = true,
}: {
  fallbackCreators: Creator[];
  fallbackVideos: SavedVideo[];
  fallbackStats: ArchiveStats;
  videoCreatorId?: string;
  videoUsername?: string;
  videoFileId?: string;
  videoLimit?: number;
  paginateVideos?: boolean;
  includeVideos?: boolean;
  includeStats?: boolean;
}) {
  const configuredBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE;
  const liveMode = Boolean(configuredBase);
  const [creators, setCreators] = useState(liveMode ? [] : fallbackCreators);
  const [videos, setVideos] = useState(liveMode ? [] : fallbackVideos);
  const [bookmarkedVideos, setBookmarkedVideos] = useState(liveMode ? [] : fallbackVideos);
  const [stats, setStats] = useState(liveMode ? emptyStats : fallbackStats);
  const [metadataSource, setMetadataSource] = useState<ArchiveDataSource>(liveMode ? "loading" : "mock");
  const [videoSource, setVideoSource] = useState<ArchiveDataSource>(liveMode ? "loading" : "mock");
  const [metadataError, setMetadataError] = useState("");
  const [videoError, setVideoError] = useState("");
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [videoRevision, setVideoRevision] = useState(0);
  const [nextVideoCursor, setNextVideoCursor] = useState<string | null>(null);
  const [nextBookmarkCursor, setNextBookmarkCursor] = useState<string | null>(null);
  const [bookmarkedVideosError, setBookmarkedVideosError] = useState("");
  const [bookmarkedVideosLoaded, setBookmarkedVideosLoaded] = useState(!liveMode);
  const [loadingMoreVideos, setLoadingMoreVideos] = useState(false);
  const [loadingBookmarkedVideos, setLoadingBookmarkedVideos] = useState(false);
  const hasLoadedMetadata = useRef(false);
  const hasLoadedVideos = useRef(false);
  const nextVideoCursorRef = useRef<string | null>(null);
  const nextBookmarkCursorRef = useRef<string | null>(null);
  const loadingMoreVideosRef = useRef(false);
  const loadingBookmarkedVideosRef = useRef(false);
  const loadMoreRetryAfterRef = useRef(0);
  const videoRequestKeyRef = useRef("");
  const videoGenerationRef = useRef(0);
  const videoRequestControllerRef = useRef<AbortController | null>(null);
  const bookmarkGenerationRef = useRef(0);
  const bookmarkRequestControllerRef = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    setMetadataRevision((current) => current + 1);
    setVideoRevision((current) => current + 1);
  }, []);
  const base = configuredBase?.replace(/\/+$/, "") || "";
  const videoPageLimit = boundedVideoPageLimit(videoLimit, paginateVideos);
  const bookmarkScopeKey = `${videoCreatorId}\0${videoUsername}`;

  const makeVideoParams = useCallback((cursor = "") => {
    const videoParams = new URLSearchParams({ limit: String(videoPageLimit) });
    if (paginateVideos) videoParams.set("page", "1");
    if (videoCreatorId) videoParams.set("creatorId", videoCreatorId);
    if (videoUsername) videoParams.set("username", videoUsername);
    if (videoFileId && !cursor) videoParams.set("fileId", videoFileId);
    if (cursor) videoParams.set("cursor", cursor);
    return videoParams;
  }, [paginateVideos, videoCreatorId, videoFileId, videoPageLimit, videoUsername]);

  const fetchVideoPage = useCallback(async (cursor = "", signal?: AbortSignal) => {
    const payload = await fetchJson<SavedVideo[] | FeedPage>(`${base}/api/videos?${makeVideoParams(cursor)}`, {
      cache: "no-store",
      signal,
    });
    return normalizeVideoPage(payload);
  }, [base, makeVideoParams]);

  useEffect(() => {
    if (!configuredBase) return;
    const controller = new AbortController();
    setMetadataSource(hasLoadedMetadata.current ? "refreshing" : "loading");
    setMetadataError("");
    Promise.allSettled([
      fetchJson<Creator[]>(`${base}/api/creators`, {
        cache: "no-store",
        signal: controller.signal,
      }).then((items) => {
        if (!controller.signal.aborted) setCreators(items);
      }),
      includeStats
        ? fetchJson<ArchiveStats>(`${base}/api/stats`, {
          cache: "no-store",
          signal: controller.signal,
        }).then((totals) => {
          if (!controller.signal.aborted) setStats(totals);
        })
        : Promise.resolve(),
    ])
      .then(([creatorResult, statsResult]) => {
        if (controller.signal.aborted) return;
        const failures: string[] = [];
        if (creatorResult.status === "rejected") failures.push(errorMessage("creators", creatorResult.reason));
        if (statsResult.status === "rejected") failures.push(errorMessage("archive totals", statsResult.reason));
        if (creatorResult.status === "fulfilled" || (includeStats && statsResult.status === "fulfilled")) {
          hasLoadedMetadata.current = true;
        }
        setMetadataSource(hasLoadedMetadata.current ? "live" : "error");
        setMetadataError(failures.join(" "));
      });
    return () => controller.abort();
  }, [base, configuredBase, includeStats, metadataRevision]);

  useEffect(() => {
    if (!configuredBase) return;
    const controller = new AbortController();
    videoRequestControllerRef.current?.abort();
    videoRequestControllerRef.current = controller;
    videoGenerationRef.current += 1;
    loadingMoreVideosRef.current = false;
    loadMoreRetryAfterRef.current = 0;
    // Reset pagination when its request scope changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingMoreVideos(false);
    setVideoSource(hasLoadedVideos.current ? "refreshing" : "loading");
    setVideoError("");
    nextVideoCursorRef.current = null;
    setNextVideoCursor(null);
    const videoRequestKey = `${videoCreatorId}\0${videoUsername}\0${videoFileId}\0${videoPageLimit}\0${paginateVideos}`;
    if (videoRequestKeyRef.current !== videoRequestKey) {
      videoRequestKeyRef.current = videoRequestKey;
      if (paginateVideos) setVideos([]);
    }
    const request = includeVideos
      ? fetchVideoPage("", controller.signal)
      : Promise.resolve({ items: [] as SavedVideo[], nextCursor: null });
    request.then((page) => {
      if (controller.signal.aborted) return;
      setVideos(page.items);
      nextVideoCursorRef.current = page.nextCursor;
      setNextVideoCursor(page.nextCursor);
      hasLoadedVideos.current = includeVideos;
      setVideoSource(includeVideos ? "live" : "mock");
    }).catch((nextError: unknown) => {
      if (controller.signal.aborted) return;
      setVideoSource(hasLoadedVideos.current ? "live" : "error");
      setVideoError(errorMessage("videos", nextError));
    });
    return () => {
      controller.abort();
      videoRequestControllerRef.current?.abort();
    };
  }, [configuredBase, fetchVideoPage, includeVideos, paginateVideos, videoRevision, videoCreatorId, videoFileId, videoPageLimit, videoUsername]);

  const loadMoreVideos = useCallback(async () => {
    const cursor = nextVideoCursorRef.current;
    if (
      !configuredBase
      || !includeVideos
      || !paginateVideos
      || !cursor
      || loadingMoreVideosRef.current
      || Date.now() < loadMoreRetryAfterRef.current
    ) return;
    const generation = videoGenerationRef.current;
    const controller = new AbortController();
    videoRequestControllerRef.current = controller;
    loadingMoreVideosRef.current = true;
    setLoadingMoreVideos(true);
    try {
      const page = await fetchVideoPage(cursor, controller.signal);
      if (controller.signal.aborted || generation !== videoGenerationRef.current) return;
      setVideos((current) => mergeVideoPage(current, page).videos);
      nextVideoCursorRef.current = page.nextCursor;
      setNextVideoCursor(page.nextCursor);
      loadMoreRetryAfterRef.current = 0;
      setVideoError("");
    } catch (nextError) {
      if (controller.signal.aborted || generation !== videoGenerationRef.current) return;
      loadMoreRetryAfterRef.current = Date.now() + VIDEO_PAGE_RETRY_DELAY_MS;
      setVideoError(errorMessage("more videos", nextError));
    } finally {
      if (generation === videoGenerationRef.current) {
        loadingMoreVideosRef.current = false;
        setLoadingMoreVideos(false);
      }
    }
  }, [configuredBase, fetchVideoPage, includeVideos, paginateVideos]);

  const retry = useCallback(() => {
    if (metadataError) setMetadataRevision((current) => current + 1);
    if (!videoError) return;
    if (nextVideoCursorRef.current) {
      loadMoreRetryAfterRef.current = 0;
      void loadMoreVideos();
    } else {
      setVideoRevision((current) => current + 1);
    }
  }, [loadMoreVideos, metadataError, videoError]);

  useEffect(() => {
    bookmarkGenerationRef.current += 1;
    bookmarkRequestControllerRef.current?.abort();
    bookmarkRequestControllerRef.current = null;
    nextBookmarkCursorRef.current = null;
    loadingBookmarkedVideosRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBookmarkedVideos(configuredBase ? [] : fallbackVideos);
    setNextBookmarkCursor(null);
    setLoadingBookmarkedVideos(false);
    setBookmarkedVideosError("");
    setBookmarkedVideosLoaded(!configuredBase);
    return () => bookmarkRequestControllerRef.current?.abort();
  }, [bookmarkScopeKey, configuredBase, fallbackVideos]);

  const fetchBookmarkedPage = useCallback(async (cursor = "", signal?: AbortSignal) => {
    const params = bookmarkedVideoPageParams(cursor, {
      creatorId: videoCreatorId,
      username: videoUsername,
      limit: videoPageLimit,
    });
    const payload = await fetchJson<SavedVideo[] | FeedPage>(`${base}/api/videos?${params}`, {
      cache: "no-store",
      signal,
    });
    return normalizeVideoPage(payload);
  }, [base, videoCreatorId, videoPageLimit, videoUsername]);

  const loadBookmarkedVideos = useCallback(async () => {
    if (!configuredBase || !includeVideos) return [] as SavedVideo[];
    bookmarkRequestControllerRef.current?.abort();
    const controller = new AbortController();
    bookmarkRequestControllerRef.current = controller;
    const generation = bookmarkGenerationRef.current + 1;
    bookmarkGenerationRef.current = generation;
    loadingBookmarkedVideosRef.current = true;
    setLoadingBookmarkedVideos(true);
    setBookmarkedVideosError("");
    try {
      const page = await fetchBookmarkedPage("", controller.signal);
      if (controller.signal.aborted || generation !== bookmarkGenerationRef.current) return [] as SavedVideo[];
      setBookmarkedVideos(page.items);
      setBookmarkedVideosLoaded(true);
      nextBookmarkCursorRef.current = page.nextCursor;
      setNextBookmarkCursor(page.nextCursor);
      return page.items;
    } catch (nextError) {
      if (controller.signal.aborted || generation !== bookmarkGenerationRef.current) return [] as SavedVideo[];
      setBookmarkedVideosError(errorMessage("bookmarked videos", nextError));
      return [] as SavedVideo[];
    } finally {
      if (generation === bookmarkGenerationRef.current) {
        loadingBookmarkedVideosRef.current = false;
        setLoadingBookmarkedVideos(false);
      }
    }
  }, [configuredBase, fetchBookmarkedPage, includeVideos]);

  const loadMoreBookmarkedVideos = useCallback(async () => {
    const cursor = nextBookmarkCursorRef.current;
    if (!configuredBase || !includeVideos || !cursor || loadingBookmarkedVideosRef.current) return;
    const generation = bookmarkGenerationRef.current;
    const controller = new AbortController();
    bookmarkRequestControllerRef.current = controller;
    loadingBookmarkedVideosRef.current = true;
    setLoadingBookmarkedVideos(true);
    setBookmarkedVideosError("");
    try {
      const page = await fetchBookmarkedPage(cursor, controller.signal);
      if (controller.signal.aborted || generation !== bookmarkGenerationRef.current) return;
      setBookmarkedVideos((current) => mergeVideoPage(current, page).videos);
      nextBookmarkCursorRef.current = page.nextCursor;
      setNextBookmarkCursor(page.nextCursor);
    } catch (nextError) {
      if (controller.signal.aborted || generation !== bookmarkGenerationRef.current) return;
      setBookmarkedVideosError(errorMessage("more bookmarked videos", nextError));
    } finally {
      if (generation === bookmarkGenerationRef.current) {
        loadingBookmarkedVideosRef.current = false;
        setLoadingBookmarkedVideos(false);
      }
    }
  }, [configuredBase, fetchBookmarkedPage, includeVideos]);

  const sources = includeVideos ? [metadataSource, videoSource] : [metadataSource];
  const hasLiveData = sources.some((status) => status === "live" || status === "refreshing");
  const isLoading = sources.some((status) => status === "loading" || status === "refreshing");
  const source: ArchiveDataSource = !liveMode ? "mock"
    : isLoading ? hasLiveData ? "refreshing" : "loading"
      : hasLiveData ? "live" : "error";

  return {
    creators,
    videos,
    bookmarkedVideos,
    stats,
    source,
    error: [metadataError, videoError].filter(Boolean).join(" "),
    refresh,
    retry,
    hasMoreVideos: Boolean(nextVideoCursor),
    hasMoreBookmarkedVideos: Boolean(nextBookmarkCursor),
    loadingMoreVideos,
    loadingBookmarkedVideos,
    bookmarkedVideosError,
    bookmarkedVideosLoaded,
    loadMoreVideos,
    loadBookmarkedVideos,
    loadMoreBookmarkedVideos,
  };
}

function errorMessage(resource: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not load ${resource}: ${detail}`;
}

export function normalizeVideoPage(payload: SavedVideo[] | FeedPage): FeedPage {
  if (Array.isArray(payload)) return { items: payload, nextCursor: null };
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    nextCursor: typeof payload.nextCursor === "string" && payload.nextCursor
      ? payload.nextCursor
      : null,
  };
}
