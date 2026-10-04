"use client";

import {
  Bookmark,
  ExternalLink,
  LayoutDashboard,
  Library,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Share2,
  Shuffle,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ComponentProps, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CreatorPicker } from "../CreatorPicker";
import { resolveCreatorId } from "../../lib/creator-id";
import { mockStats } from "../../lib/mock-data";
import {
  readAutoplayPreference,
  readDefaultFeed,
  readMutedPreference,
  writeMutedPreference,
} from "../../lib/playback-preferences";
import type { Creator, SavedVideo } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import { useBookmarks } from "../../lib/useBookmarks";
import { useModalDialog } from "../../lib/useModalDialog";
import styles from "./mobile-feed.module.css";

interface MobileFeedProps {
  creators: Creator[];
  videos: SavedVideo[];
}

const FEED_HINT_STORAGE_KEY = "rewind-feed-hint-seen";
const VIDEO_PAGE_SIZE = 36;
const CARD_WINDOW_SIZE = 7;
const CARD_WINDOW_BEHIND = 3;
const PLAYABLE_READY_STATE = 2;
const PRELOAD_BUFFER_SECONDS = 5;
const CANDIDATE_BUFFER_SECONDS = 3;
const SWIPE_ANTICIPATION_FRACTION = 0.1;
const PLAYBACK_WAIT_TIMEOUT_MS = 15_000;
const KEYBOARD_SEEK_SECONDS = 5;

export function MobileFeed({ creators, videos }: MobileFeedProps) {
  const searchParams = useSearchParams();
  const apiBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE?.replace(/\/+$/, "") || "";
  const requestedVideoId = searchParams.get("video") || "";
  const requestedCreatorId = searchParams.get("creator") || "all";
  const requestedJumpHandled = useRef(!requestedVideoId);
  const [creatorId, setCreatorId] = useState(requestedCreatorId);
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: videos,
    fallbackStats: mockStats,
    videoCreatorId: creatorId === "all" ? "" : creatorId,
    videoFileId: requestedVideoId,
    videoLimit: VIDEO_PAGE_SIZE,
    paginateVideos: true,
    includeStats: false,
  });
  const bookmarks = useBookmarks(apiBase);
  const liveCreators = archive.creators;
  const archiveVideos = archive.videos;
  const {
    hasMoreVideos,
    hasMoreBookmarkedVideos,
    loadingBookmarkedVideos,
    loadingMoreVideos,
    loadBookmarkedVideos,
    loadMoreBookmarkedVideos,
    loadMoreVideos,
  } = archive;
  const [activeId, setActiveId] = useState(requestedVideoId);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [shuffleReady, setShuffleReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const [mutePreferenceReady, setMutePreferenceReady] = useState(false);
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [playbackError, setPlaybackError] = useState("");
  const [presentedVideoId, setPresentedVideoId] = useState("");
  const [preloadReadyVideoId, setPreloadReadyVideoId] = useState("");
  const [residentVideoIds, setResidentVideoIds] = useState<string[]>([]);
  const [bufferedVideoIds, setBufferedVideoIds] = useState<Set<string>>(() => new Set());
  const [scrollDirection, setScrollDirection] = useState<1 | -1>(1);
  const [scrollCandidateId, setScrollCandidateId] = useState("");
  const [pageVisible, setPageVisible] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [menuVideoId, setMenuVideoId] = useState("");
  const [feedView, setFeedView] = useState<"all" | "bookmarks">("all");
  const saved = bookmarks.visibleIds;
  const bookmarksReady = bookmarks.ready;
  const [shareStatus, setShareStatus] = useState("");
  const [deleteVideo, setDeleteVideo] = useState<SavedVideo | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [feedStatus, setFeedStatus] = useState("");
  const [hintVisible, setHintVisible] = useState(false);
  const [removedVideoIds, setRemovedVideoIds] = useState<Set<string>>(() => new Set());
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const activeIdRef = useRef(activeId);
  const scrollDirectionRef = useRef<1 | -1>(1);
  const failedVideoIdsRef = useRef(new Set<string>());
  const soundChoiceRevision = useRef(0);
  const feedScrollerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const scrubbingVideoIdRef = useRef("");
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const pendingBookmarkFocusRef = useRef<string | null>(null);
  const bookmarkPageStartRef = useRef<number | null>(null);
  const wasPausedBeforeDeleteRef = useRef(false);
  const { dialogRef, returnFocusRef } = useModalDialog(Boolean(deleteVideo), closeDeleteVideo);

  const allLiveVideos = useMemo(
    () => archiveVideos.filter((video) => !removedVideoIds.has(video.id)),
    [archiveVideos, removedVideoIds],
  );
  const liveBookmarkedVideos = useMemo(() => {
    const byId = new Map(
      archive.bookmarkedVideos
        .filter((video) => !removedVideoIds.has(video.id))
        .map((video) => [video.id, video]),
    );
    for (const video of allLiveVideos) {
      if (saved.has(video.id) && !byId.has(video.id)) byId.set(video.id, video);
    }
    return [...byId.values()];
  }, [allLiveVideos, archive.bookmarkedVideos, removedVideoIds, saved]);

  const resolvedCreatorId = useMemo(
    () => resolveCreatorId(creatorId, liveCreators),
    [creatorId, liveCreators],
  );
  const orderedAllVideos = useMemo(
    () => shuffleVideoPages(allLiveVideos, shuffleSeed, VIDEO_PAGE_SIZE),
    [allLiveVideos, shuffleSeed],
  );
  const orderedBookmarkedVideos = useMemo(
    () => shuffleVideoPages(liveBookmarkedVideos, shuffleSeed, VIDEO_PAGE_SIZE),
    [liveBookmarkedVideos, shuffleSeed],
  );
  const allCreatorVideos = useMemo(
    () =>
      resolvedCreatorId === "all"
        ? orderedAllVideos
        : orderedAllVideos.filter((video) => video.creatorId === resolvedCreatorId),
    [orderedAllVideos, resolvedCreatorId],
  );
  const bookmarkedCreatorVideos = useMemo(
    () => {
      if (!archive.bookmarkedVideosLoaded) return [];
      const videosForCreator = resolvedCreatorId === "all"
        ? orderedBookmarkedVideos
        : orderedBookmarkedVideos.filter((video) => video.creatorId === resolvedCreatorId);
      return videosForCreator.filter((video) => saved.has(video.id));
    },
    [archive.bookmarkedVideosLoaded, orderedBookmarkedVideos, resolvedCreatorId, saved],
  );
  const filteredVideos = feedView === "bookmarks" ? bookmarkedCreatorVideos : allCreatorVideos;
  const bookmarkError = bookmarks.error || archive.bookmarkedVideosError;
  const feedError = bookmarkError || archive.error;
  const bookmarkPagePending = feedView === "bookmarks"
    && !bookmarkError
    && (!bookmarksReady || !archive.bookmarkedVideosLoaded || loadingBookmarkedVideos);
  const controlsAvailable = filteredVideos.length > 0;
  const hasActiveVideo = filteredVideos.some((video) => video.id === activeId);
  const requestedVideoPending = Boolean(requestedVideoId)
    && (archive.source === "loading" || archive.source === "refreshing")
    && !hasActiveVideo;
  const currentActiveId = hasActiveVideo
    ? activeId
    : requestedVideoPending
      ? ""
      : filteredVideos[0]?.id ?? "";
  // Audio can alternate between playing and waiting without presenting a frame.
  const waitingForPlayback = buffering || presentedVideoId !== currentActiveId;
  const activeIndex = filteredVideos.findIndex((video) => video.id === currentActiveId);
  const activeVideo = activeIndex >= 0 ? filteredVideos[activeIndex] : undefined;
  const scrollCandidateIndex = filteredVideos.findIndex((video) => video.id === scrollCandidateId);
  const incomingVideoId = Math.abs(scrollCandidateIndex - activeIndex) === 1 ? scrollCandidateId : "";
  const directionNeighbor = filteredVideos[activeIndex + scrollDirection] || filteredVideos[activeIndex - scrollDirection];
  const preloadVideoId = incomingVideoId || directionNeighbor?.id || "";
  const canPreload = Boolean(currentActiveId) && pageVisible && !paused && (
    Boolean(incomingVideoId) || (preloadReadyVideoId === currentActiveId && !buffering)
  );
  const windowAnchor = Math.max(activeIndex, 0);
  const unclampedWindowStart = Math.max(0, windowAnchor - CARD_WINDOW_BEHIND);
  const windowStart = Math.max(
    0,
    Math.min(unclampedWindowStart, filteredVideos.length - CARD_WINDOW_SIZE),
  );
  const windowEnd = Math.min(filteredVideos.length, windowStart + CARD_WINDOW_SIZE);
  const renderedVideos = useMemo(
    () => filteredVideos.slice(windowStart, windowEnd),
    [filteredVideos, windowEnd, windowStart],
  );

  const playIfReady = useCallback((id: string, video: HTMLVideoElement, userInitiated = false) => {
    if (
      !mutePreferenceReady
      || !video.isConnected
      || id !== currentActiveId
      || id !== activeIdRef.current
      || (paused && !userInitiated)
      || document.visibilityState === "hidden"
    ) return;

    if (userInitiated) soundChoiceRevision.current += 1;
    const soundRevision = soundChoiceRevision.current;
    video.muted = muted;
    // Mobile browsers may defer preload until play() is requested. Keep the
    // poster until a frame arrives, but never wait for that frame to call play().
    if (video.readyState < PLAYABLE_READY_STATE) setBuffering(true);
    video.play().catch((error: unknown) => {
      if (isAbortError(error) || !video.isConnected || id !== activeIdRef.current
        || soundRevision !== soundChoiceRevision.current) return;
      // A fresh page may need muted autoplay, but never undo a sound/play tap.
      if (!video.muted && isAutoplayPolicyError(error) && soundRevision === 0) {
        video.muted = true;
        setMuted(true);
        void video.play().catch((retryError: unknown) => {
          if (isAbortError(retryError) || !video.isConnected || id !== activeIdRef.current
            || soundRevision !== soundChoiceRevision.current) return;
          setPaused(true);
          setPlaybackError("Playback was blocked. Tap play to retry.");
        });
        return;
      }
      setPaused(true);
      setPlaybackError("This video could not start. Tap play to retry.");
    });
  }, [currentActiveId, mutePreferenceReady, muted, paused]);

  const prepareNextVideo = useCallback((id: string, video: HTMLVideoElement) => {
    if (id === activeIdRef.current) setPreloadReadyVideoId(hasPlaybackBuffer(video) ? id : "");
    if (hasPlaybackBuffer(video, CANDIDATE_BUFFER_SECONDS)) {
      if (id !== activeIdRef.current) video.preload = "none";
      setBufferedVideoIds((current) => current.has(id) ? current : new Set(current).add(id));
    }
  }, []);

  useEffect(() => {
    // Live production data arrives after hydration, so choosing the seed here
    // avoids a server/client order mismatch while still varying every visit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShuffleSeed(randomFeedSeed());
    setShuffleReady(true);
  }, []);

  useEffect(() => {
    if (!controlsAvailable) return;
    try {
      if (window.localStorage.getItem(FEED_HINT_STORAGE_KEY) === "1") return;
      window.localStorage.setItem(FEED_HINT_STORAGE_KEY, "1");
    } catch {
      // The hint can still appear when storage is unavailable.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHintVisible(true);
    const timer = window.setTimeout(() => setHintVisible(false), 4_500);
    return () => window.clearTimeout(timer);
  }, [controlsAvailable]);

  useEffect(() => {
    // Start muted for autoplay, then restore this device's last explicit choice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMuted(readMutedPreference(window.localStorage));
    const autoplay = readAutoplayPreference(window.localStorage);
    setAutoplayEnabled(autoplay);
    setPaused(!autoplay);
    // Exact links from the library and creator gallery must always reveal the
    // requested file, even if this device normally opens on Bookmarks.
    setFeedView(requestedVideoId ? "all" : readDefaultFeed(window.localStorage));
    setMutePreferenceReady(true);
  }, [requestedVideoId]);

  useEffect(() => {
    if (feedView !== "bookmarks" || !bookmarksReady) return;
    void loadBookmarkedVideos();
  }, [bookmarks.serverRevision, bookmarksReady, feedView, loadBookmarkedVideos]);

  useLayoutEffect(() => {
    const pageStart = bookmarkPageStartRef.current;
    if (pageStart === null || loadingBookmarkedVideos) return;
    bookmarkPageStartRef.current = null;
    const scroller = feedScrollerRef.current;
    if (!scroller) return;
    if (feedView !== "bookmarks" || !filteredVideos[pageStart]) {
      scroller.style.scrollSnapType = "";
      return;
    }
    // Safari can follow the old snapped footer to the end of the appended page.
    scroller.scrollTo({ top: pageStart * scroller.clientHeight, behavior: "instant" });
    const frame = window.requestAnimationFrame(() => { scroller.style.scrollSnapType = ""; });
    return () => {
      window.cancelAnimationFrame(frame);
      scroller.style.scrollSnapType = "";
    };
  }, [feedView, filteredVideos, loadingBookmarkedVideos]);

  function loadNextBookmarkPage() {
    bookmarkPageStartRef.current = filteredVideos.length;
    if (feedScrollerRef.current) feedScrollerRef.current.style.scrollSnapType = "none";
    void loadMoreBookmarkedVideos();
  }

  useEffect(() => {
    activeIdRef.current = currentActiveId;
    const focusedCard = document.activeElement instanceof Element
      ? document.activeElement.closest<HTMLElement>("[data-feed-card]")
      : null;
    if (focusedCard && focusedCard.dataset.videoId !== currentActiveId) {
      document.getElementById("feed-stage")?.focus({ preventScroll: true });
    }
  }, [currentActiveId]);

  useEffect(() => {
    const targetId = pendingBookmarkFocusRef.current;
    if (targetId === null || (targetId && targetId !== currentActiveId)) return;
    const frame = window.requestAnimationFrame(() => {
      pendingBookmarkFocusRef.current = null;
      if (!targetId) {
        document.getElementById("feed-bookmarks-tab")?.focus({ preventScroll: true });
        return;
      }
      const target = Array.from(
        feedScrollerRef.current?.querySelectorAll<HTMLElement>("[data-video-id]") || [],
      ).find((node) => node.dataset.videoId === targetId);
      target?.scrollIntoView({ block: "start", behavior: "auto" });
      const bookmarkButton = target?.querySelector<HTMLButtonElement>("[data-bookmark-control]");
      (bookmarkButton || document.getElementById("feed-stage"))?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentActiveId, renderedVideos]);

  useEffect(() => {
    if (!menuVideoId) return;
    const trigger = document.getElementById(`feed-more-${menuVideoId}`);
    const focusFrame = window.requestAnimationFrame(() => {
      actionMenuRef.current?.querySelector<HTMLElement>('a[href], button:not(:disabled)')?.focus();
    });

    function isInsideMenu(target: EventTarget | null) {
      return target instanceof Node
        && (actionMenuRef.current?.contains(target) || trigger?.contains(target));
    }

    function closeMenu(restoreFocus: boolean) {
      setMenuVideoId("");
      if (restoreFocus) {
        window.requestAnimationFrame(() => trigger?.focus());
      }
    }

    function handlePointerDown(event: PointerEvent) {
      if (!isInsideMenu(event.target)) closeMenu(false);
    }

    function handleFocusIn(event: FocusEvent) {
      if (!isInsideMenu(event.target)) closeMenu(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuVideoId]);

  useEffect(() => {
    if (!shuffleReady || requestedJumpHandled.current) return;
    const target = Array.from(feedScrollerRef.current?.querySelectorAll<HTMLElement>("[data-video-id]") || [])
      .find((node) => node.dataset.videoId === requestedVideoId);
    if (target) {
      requestedJumpHandled.current = true;
      target.scrollIntoView({ block: "start" });
      return;
    }
    if (archiveVideos.some((video) => video.id === requestedVideoId)) return;
    if (archive.source !== "loading" && archive.source !== "refreshing") requestedJumpHandled.current = true;
  }, [archive.source, archiveVideos, filteredVideos, requestedVideoId, shuffleReady]);

  useEffect(() => {
    if (!shuffleReady) return;
    const scroller = feedScrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    let previousTop = scroller.scrollTop;

    function updateScrollPosition() {
      frame = 0;
      if (!scroller || !requestedJumpHandled.current || !filteredVideos.length || !scroller.clientHeight) return;
      const top = Math.max(0, scroller.scrollTop);
      const movement = top - previousTop;
      previousTop = top;
      if (Math.abs(movement) > 1) {
        scrollDirectionRef.current = movement > 0 ? 1 : -1;
        setScrollDirection(scrollDirectionRef.current);
      }
      const position = top / scroller.clientHeight;
      const index = Math.max(0, Math.min(filteredVideos.length - 1, Math.round(position)));
      const id = filteredVideos[index].id;
      const direction = scrollDirectionRef.current;
      const candidateIndex = direction > 0 ? Math.ceil(position) : Math.floor(position);
      const movingTowardCandidate = direction > 0
        ? position - index >= SWIPE_ANTICIPATION_FRACTION
        : index - position >= SWIPE_ANTICIPATION_FRACTION;
      setScrollCandidateId(movingTowardCandidate && candidateIndex !== index
        ? filteredVideos[candidateIndex]?.id || ""
        : "");

      if (id === activeIdRef.current) return;
      videoRefs.current.get(activeIdRef.current)?.pause();
      activeIdRef.current = id;
      const nextVideo = videoRefs.current.get(id);
      const failed = failedVideoIdsRef.current.has(id);
      const frameReady = !failed && (nextVideo?.readyState ?? 0) >= PLAYABLE_READY_STATE
        && (nextVideo?.videoWidth ?? 0) > 0;
      setActiveId(id);
      setPreloadReadyVideoId(!failed && nextVideo && hasPlaybackBuffer(nextVideo) ? id : "");
      setPaused(failed || !autoplayEnabled);
      setBuffering(!failed && !frameReady);
      setPlaybackError(failed ? "This archived file could not be played." : "");
      setPresentedVideoId(frameReady ? id : "");
      setControlsVisible(false);
      setMenuVideoId("");
      if (progressRef.current) progressRef.current.style.width = "0%";
      if (seekRef.current) seekRef.current.value = "0";
    }

    function scheduleScrollUpdate() {
      if (!frame) frame = window.requestAnimationFrame(updateScrollPosition);
    }

    // Position remains observable even when a fling reaches a virtual spacer.
    scroller.addEventListener("scroll", scheduleScrollUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleScrollUpdate);
    observer.observe(scroller);
    scheduleScrollUpdate();
    return () => {
      scroller.removeEventListener("scroll", scheduleScrollUpdate);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [autoplayEnabled, filteredVideos, shuffleReady]);

  useEffect(() => {
    if (!shuffleReady) return;
    function syncPlayback() {
      setPageVisible(document.visibilityState !== "hidden");
      for (const [id, video] of videoRefs.current) {
        if (id === currentActiveId && !paused && document.visibilityState !== "hidden") {
          playIfReady(id, video);
        } else {
          video.pause();
        }
      }
    }
    function pausePlayback() {
      setPageVisible(false);
      for (const video of videoRefs.current.values()) video.pause();
    }
    syncPlayback();
    document.addEventListener("visibilitychange", syncPlayback);
    window.addEventListener("pageshow", syncPlayback);
    window.addEventListener("pagehide", pausePlayback);
    return () => {
      document.removeEventListener("visibilitychange", syncPlayback);
      window.removeEventListener("pageshow", syncPlayback);
      window.removeEventListener("pagehide", pausePlayback);
    };
  }, [currentActiveId, muted, paused, playIfReady, shuffleReady]);

  useEffect(() => {
    if (
      !currentActiveId || !mutePreferenceReady || !pageVisible || paused
      || !waitingForPlayback
    ) return;
    const waitingVideo = videoRefs.current.get(currentActiveId);
    let canceled = false;
    const frame = waitingVideo?.requestVideoFrameCallback?.(() => {
      if (canceled || activeIdRef.current !== currentActiveId || waitingVideo.paused
        || document.visibilityState === "hidden") return;
      window.clearTimeout(timer);
      setPresentedVideoId(currentActiveId);
      setBuffering(false);
    });
    const timer = window.setTimeout(() => {
      const video = videoRefs.current.get(currentActiveId);
      if (activeIdRef.current !== currentActiveId || !video || document.visibilityState === "hidden") return;
      video.pause();
      setPaused(true);
      setBuffering(false);
      setPreloadReadyVideoId("");
      setPlaybackError("Video is taking too long to load. Tap retry.");
      setControlsVisible(true);
    }, PLAYBACK_WAIT_TIMEOUT_MS);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
      if (frame !== undefined) waitingVideo?.cancelVideoFrameCallback(frame);
    };
  }, [currentActiveId, mutePreferenceReady, pageVisible, paused, waitingForPlayback]);

  useEffect(() => {
    // Preserve the previous player's buffer and position without fetching unseen
    // older videos. Only one incoming player may fetch speculative media.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResidentVideoIds((current) => {
      const neighbors = filteredVideos.slice(Math.max(0, activeIndex - 1), activeIndex + 2);
      const next = neighbors
        .filter((video) => video.id === currentActiveId
          || current.includes(video.id)
          || (canPreload && video.id === preloadVideoId))
        .map((video) => video.id);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [activeIndex, canPreload, currentActiveId, filteredVideos, preloadVideoId]);

  useEffect(() => {
    // Keep readiness bookkeeping bounded to the same small player window.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBufferedVideoIds((current) => {
      const next = new Set([...current].filter((id) => id === currentActiveId || residentVideoIds.includes(id)));
      return next.size === current.size ? current : next;
    });
  }, [currentActiveId, residentVideoIds]);

  useEffect(() => {
    if (
      feedView !== "all"
      || !hasMoreVideos
      || loadingMoreVideos
      || activeIndex < filteredVideos.length - 8
    ) return;
    void loadMoreVideos();
  }, [activeIndex, feedView, filteredVideos.length, hasMoreVideos, loadingMoreVideos, loadMoreVideos]);

  const setVideoRef = useCallback((id: string, node: HTMLVideoElement | null) => {
    if (node) {
      videoRefs.current.set(id, node);
      return;
    }
    const retiredVideo = videoRefs.current.get(id);
    videoRefs.current.delete(id);
    // Removing a playing element alone does not reliably abort its request.
    if (retiredVideo) {
      retiredVideo.pause();
      retiredVideo.removeAttribute("src");
      retiredVideo.load();
    }
  }, []);

  const resetFeedPosition = useCallback((
    nextActiveId: string,
    { scrollToTop = true, showControls = false }: { scrollToTop?: boolean; showControls?: boolean } = {},
  ) => {
    bookmarkPageStartRef.current = null;
    if (feedScrollerRef.current) feedScrollerRef.current.style.scrollSnapType = "";
    scrollDirectionRef.current = 1;
    setScrollDirection(1);
    setScrollCandidateId("");
    if (scrollToTop) feedScrollerRef.current?.scrollTo({ top: 0, behavior: "auto" });
    activeIdRef.current = nextActiveId;
    setActiveId(nextActiveId);
    if (nextActiveId !== currentActiveId) {
      const failed = failedVideoIdsRef.current.has(nextActiveId);
      const nextElement = videoRefs.current.get(nextActiveId);
      setPaused(failed || !autoplayEnabled);
      setBuffering(Boolean(nextActiveId) && !failed);
      setPlaybackError(failed ? "This archived file could not be played." : "");
      setPresentedVideoId("");
      setPreloadReadyVideoId(
        !failed && nextElement && hasPlaybackBuffer(nextElement) ? nextActiveId : "",
      );
      if (progressRef.current) progressRef.current.style.width = "0%";
      if (seekRef.current) seekRef.current.value = "0";
    }
    setControlsVisible(showControls);
    setMenuVideoId("");
  }, [autoplayEnabled, currentActiveId]);

  const toggleSaved = useCallback((id: string) => {
    const wasSaved = saved.has(id);
    if (feedView === "bookmarks" && wasSaved) {
      const currentIndex = bookmarkedCreatorVideos.findIndex((video) => video.id === id);
      const adjacentVideo = bookmarkedCreatorVideos[currentIndex + 1]
        || bookmarkedCreatorVideos[currentIndex - 1];
      const nextId = adjacentVideo?.id || "";
      pendingBookmarkFocusRef.current = nextId;
      resetFeedPosition(nextId, { scrollToTop: false, showControls: Boolean(nextId) });
    }
    bookmarks.toggle(id);
  }, [bookmarkedCreatorVideos, bookmarks, feedView, resetFeedPosition, saved]);

  async function shareVideo(video: SavedVideo) {
    if (navigator.share) {
      await navigator.share({ title: video.title, url: video.sourceUrl }).catch(() => undefined);
      return;
    }
    try {
      await navigator.clipboard.writeText(video.sourceUrl);
      setShareStatus("Original link copied");
      window.setTimeout(() => setShareStatus(""), 1800);
    } catch {
      setShareStatus("Could not copy the link");
    }
  }

  function openDeleteVideo(video: SavedVideo) {
    returnFocusRef.current = document.getElementById(`feed-more-${video.id}`);
    wasPausedBeforeDeleteRef.current = paused;
    setPaused(true);
    setMenuVideoId("");
    setDeleteVideo(video);
    setDeleteError("");
  }

  function closeDeleteVideo() {
    if (deleting) return;
    setDeleteVideo(null);
    setDeleteError("");
    setPaused(wasPausedBeforeDeleteRef.current);
  }

  async function confirmDeleteVideo() {
    if (!deleteVideo || deleting) return;
    if (!apiBase) {
      setDeleteError("The live backend connection is required to move videos to trash.");
      return;
    }

    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`${apiBase}/api/videos/${encodeURIComponent(deleteVideo.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmFileId: deleteVideo.id }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `Move to trash failed (${response.status})`);
      }

      const deletedIndex = filteredVideos.findIndex((video) => video.id === deleteVideo.id);
      const nextVideo = filteredVideos[deletedIndex + 1] || filteredVideos[deletedIndex - 1];
      const nextId = nextVideo?.id || "";
      const nextFailed = failedVideoIdsRef.current.has(nextId);
      const nextElement = videoRefs.current.get(nextId);
      activeIdRef.current = nextId;
      setActiveId(nextId);
      setPreloadReadyVideoId(
        !nextFailed && nextElement && hasPlaybackBuffer(nextElement) ? nextId : "",
      );
      setPaused(!autoplayEnabled || !nextId || nextFailed);
      setBuffering(Boolean(nextId) && !nextFailed);
      setPlaybackError(nextFailed ? "This archived file could not be played." : "");
      setPresentedVideoId("");
      setControlsVisible(false);
      setRemovedVideoIds((current) => new Set(current).add(deleteVideo.id));
      returnFocusRef.current = document.getElementById("feed-stage");
      setDeleteVideo(null);
      setFeedStatus(`Moved “${deleteVideo.title}” to trash.`);
      window.setTimeout(() => setFeedStatus(""), 2600);
      archive.refresh();

      if (nextId) {
        window.requestAnimationFrame(() => {
          const target = Array.from(document.querySelectorAll<HTMLElement>("[data-video-id]"))
            .find((node) => node.dataset.videoId === nextId);
          target?.scrollIntoView({ block: "start" });
        });
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  function selectCreator(id: string) {
    if (id === resolvedCreatorId) return;
    const sourceVideos = feedView === "bookmarks" ? orderedBookmarkedVideos : orderedAllVideos;
    const nextVideos = id === "all"
      ? sourceVideos
      : sourceVideos.filter((video) => video.creatorId === id);
    setCreatorId(id);
    resetFeedPosition(nextVideos[0]?.id || "");
  }

  function selectFeedView(view: "all" | "bookmarks") {
    if (view === feedView) return;
    const nextVideos = view === "bookmarks" ? bookmarkedCreatorVideos : allCreatorVideos;
    setFeedView(view);
    resetFeedPosition(nextVideos[0]?.id || "");
  }

  function retryFeed() {
    if (bookmarkError) {
      if (archive.bookmarkedVideosError) void loadBookmarkedVideos();
      bookmarks.retry();
    } else {
      archive.retry();
    }
  }

  function shuffleFeed() {
    const nextSeed = randomFeedSeed();
    const sourceVideos = feedView === "bookmarks" ? liveBookmarkedVideos : allLiveVideos;
    const nextOrdered = shuffleVideos(sourceVideos, nextSeed);
    const nextCreatorVideos = resolvedCreatorId === "all"
      ? nextOrdered
      : nextOrdered.filter((video) => video.creatorId === resolvedCreatorId);
    const nextVideos = feedView === "bookmarks"
      ? nextCreatorVideos.filter((video) => saved.has(video.id))
      : nextCreatorVideos;
    setShuffleSeed(nextSeed);
    resetFeedPosition(nextVideos[0]?.id || "");
  }

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    soundChoiceRevision.current += 1;
    const activeVideo = videoRefs.current.get(currentActiveId);
    if (activeVideo) activeVideo.muted = nextMuted;
    setMuted(nextMuted);
    writeMutedPreference(window.localStorage, nextMuted);
  }, [currentActiveId, muted]);

  const retryPlayback = useCallback(() => {
    const activeVideo = videoRefs.current.get(currentActiveId);
    const shouldReload = Boolean(
      playbackError || activeVideo?.error || failedVideoIdsRef.current.has(currentActiveId),
    );
    failedVideoIdsRef.current.delete(currentActiveId);
    setPlaybackError("");
    setBuffering(true);
    setPaused(false);
    if (activeVideo && shouldReload) {
      setPreloadReadyVideoId("");
      activeVideo.load();
    }
    // Keep play() inside the tap/keyboard gesture so Safari can authorize sound
    // even when the media is still loading.
    if (activeVideo) playIfReady(currentActiveId, activeVideo, true);
  }, [currentActiveId, playbackError, playIfReady]);

  useEffect(() => {
    function handleFeedShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
        || deleteVideo
        || shouldIgnoreFeedShortcut(event.target)
      ) return;

      const key = event.key.toLowerCase();
      if (event.repeat && (key === " " || key === "m" || key === "b")) return;
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "m", "b"].includes(key)) {
        setHintVisible(false);
      }

      if (key === " ") {
        if (!currentActiveId) return;
        event.preventDefault();
        if (paused) retryPlayback();
        else setPaused(true);
        return;
      }

      if (key === "arrowup" || key === "arrowdown") {
        const offset = key === "arrowup" ? -1 : 1;
        const nextVideo = filteredVideos[activeIndex + offset];
        event.preventDefault();
        if (!nextVideo) {
          if (key === "arrowdown" && feedView === "all" && hasMoreVideos) void loadMoreVideos();
          return;
        }
        const target = Array.from(feedScrollerRef.current?.querySelectorAll<HTMLElement>("[data-video-id]") || [])
          .find((node) => node.dataset.videoId === nextVideo.id);
        target?.scrollIntoView({ block: "start", behavior: preferredFeedScrollBehavior() });
        return;
      }

      if (key === "arrowleft" || key === "arrowright") {
        const video = videoRefs.current.get(currentActiveId);
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
        event.preventDefault();
        const delta = key === "arrowleft" ? -KEYBOARD_SEEK_SECONDS : KEYBOARD_SEEK_SECONDS;
        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta));
        const percentage = video.currentTime / video.duration * 100;
        if (progressRef.current) progressRef.current.style.width = `${percentage}%`;
        if (seekRef.current) seekRef.current.value = String(percentage);
        return;
      }

      if (key === "m") {
        if (!currentActiveId) return;
        event.preventDefault();
        toggleMute();
        return;
      }

      if (key === "b") {
        if (!currentActiveId) return;
        event.preventDefault();
        toggleSaved(currentActiveId);
      }
    }

    document.addEventListener("keydown", handleFeedShortcut);
    return () => document.removeEventListener("keydown", handleFeedShortcut);
  }, [activeIndex, currentActiveId, deleteVideo, feedView, filteredVideos, hasMoreVideos, loadMoreVideos, paused, retryPlayback, toggleMute, toggleSaved]);

  const showControlBar = controlsVisible || !controlsAvailable;

  function seekToPercentage(id: string, percentage: number) {
    const element = videoRefs.current.get(id);
    if (id !== activeIdRef.current || !element || !Number.isFinite(element.duration) || element.duration <= 0) return;
    element.currentTime = element.duration * percentage / 100;
    if (progressRef.current) progressRef.current.style.width = `${percentage}%`;
  }

  return (
    <main className={styles.appShell}>
      <h1 className="sr-only">Saved video feed</h1>
      <section
        className={styles.stage}
        id="feed-stage"
        tabIndex={-1}
        aria-label="Saved video feed"
        aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight M B"
      >
        <div
          className={`${styles.controlBar} ${showControlBar ? styles.controlBarVisible : ""}`}
          aria-hidden={!showControlBar}
          inert={!showControlBar ? true : undefined}
        >
          <div className={styles.feedTabs} role="group" aria-label="Feed view">
            <button
              className={feedView === "all" ? styles.feedTabActive : styles.feedTab}
              type="button"
              aria-pressed={feedView === "all"}
              onClick={() => selectFeedView("all")}
            >
              All
            </button>
            <button
              className={feedView === "bookmarks" ? styles.feedTabActive : styles.feedTab}
              id="feed-bookmarks-tab"
              type="button"
              aria-pressed={feedView === "bookmarks"}
              onClick={() => selectFeedView("bookmarks")}
            >
              Bookmarks
            </button>
          </div>
          <div className={styles.controlRow}>
            <CreatorPicker
              creators={liveCreators}
              value={resolvedCreatorId}
              onChange={selectCreator}
              compact
            />
            <div className={styles.controlActions}>
              <Link className={styles.iconButton} href="/dashboard/videos" aria-label="Open video library">
                <Library size={19} />
              </Link>
              <button
                className={styles.iconButton}
                onClick={shuffleFeed}
                type="button"
                aria-label="Shuffle feed"
                disabled={!controlsAvailable}
              >
                <Shuffle size={18} />
              </button>
              <button
                className={styles.iconButton}
                onClick={toggleMute}
                type="button"
                aria-label={muted ? "Turn sound on" : "Mute videos"}
                disabled={!currentActiveId}
              >
                {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
              <button
                className={styles.iconButton}
                onClick={() => paused ? retryPlayback() : setPaused(true)}
                type="button"
                aria-label={paused ? "Play video" : "Pause video"}
                disabled={!currentActiveId}
              >
                {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
              </button>
            </div>
          </div>
        </div>

        {hintVisible && controlsAvailable && !feedError ? (
          <p className={styles.feedHint} role="status">Tap for controls · swipe to browse</p>
        ) : null}

        {activeVideo ? (
          <p className="sr-only" role="status" aria-atomic="true">
            {`Now viewing ${activeVideo.title} by @${activeVideo.username}, video ${activeIndex + 1}.`}
          </p>
        ) : null}

        <div id="feed-video-list" className={styles.feedScroller} ref={feedScrollerRef}>
          {filteredVideos.map((video) => (
            <div key={`snap-${video.id}`} className={styles.feedSnap} aria-hidden="true" />
          ))}
          {renderedVideos.map((video, windowIndex) => {
            const index = windowStart + windowIndex;
            const isActive = video.id === currentActiveId;
            const keepPlayer = isActive || (canPreload && video.id === preloadVideoId) || (
              Math.abs(index - activeIndex) <= 1 && residentVideoIds.includes(video.id)
            );
            const warmPlayer = canPreload && video.id === preloadVideoId && !bufferedVideoIds.has(video.id);
            const isSaved = saved.has(video.id);
            const showControls = isActive && controlsVisible;
            return (
              <article
                className={styles.feedCard}
                data-feed-card
                data-video-id={video.id}
                key={video.id}
                style={{ "--wash": video.accent, top: `${index * 100}%` } as React.CSSProperties}
                aria-label={isActive ? `${video.title} by @${video.username}` : undefined}
                aria-hidden={!isActive}
                inert={!isActive ? true : undefined}
              >
                {keepPlayer ? (
                  <FeedVideo
                    className={styles.video}
                    videoId={video.id}
                    onVideoRef={setVideoRef}
                    src={video.videoUrl}
                    muted={muted}
                    playsInline
                    preload={pageVisible && (isActive || warmPlayer) ? "auto" : "none"}
                    aria-hidden="true"
                    onTimeUpdate={(event) => {
                      if (activeIdRef.current !== video.id || scrubbingVideoIdRef.current === video.id) return;
                      const element = event.currentTarget;
                      prepareNextVideo(video.id, element);
                      const value = element.duration ? element.currentTime / element.duration : 0;
                      if (progressRef.current) {
                        progressRef.current.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
                      }
                      if (seekRef.current) seekRef.current.value = String(value * 100);
                    }}
                    onLoadedData={(event) => prepareNextVideo(video.id, event.currentTarget)}
                    onCanPlay={(event) => prepareNextVideo(video.id, event.currentTarget)}
                    onProgress={(event) => prepareNextVideo(video.id, event.currentTarget)}
                    onEnded={(event) => playIfReady(video.id, event.currentTarget)}
                    onPlaying={(event) => {
                      const element = event.currentTarget;
                      if (activeIdRef.current !== video.id || document.visibilityState === "hidden") {
                        element.pause();
                        return;
                      }
                      failedVideoIdsRef.current.delete(video.id);
                      setPlaybackError("");
                      setPaused(false);
                      prepareNextVideo(video.id, element);
                      // A playing event can arrive while the picture is still
                      // stalled. Only the frame callback clears that wait.
                      if (typeof element.requestVideoFrameCallback !== "function" && element.videoWidth > 0) {
                        setPresentedVideoId(video.id);
                        setBuffering(false);
                      }
                    }}
                    onWaiting={() => {
                      if (activeIdRef.current === video.id) {
                        setBuffering(true);
                        setPreloadReadyVideoId("");
                      }
                    }}
                    onError={() => {
                      failedVideoIdsRef.current.add(video.id);
                      if (activeIdRef.current !== video.id) return;
                      setPreloadReadyVideoId("");
                      setPaused(true);
                      setBuffering(false);
                      setPlaybackError("This archived file could not be played.");
                    }}
                  />
                ) : null}
                {video.thumbnailUrl && Math.abs(index - activeIndex) <= 1 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className={`${styles.videoPoster} ${presentedVideoId === video.id ? styles.videoPosterHidden : ""}`}
                    src={video.thumbnailUrl}
                    alt=""
                    fetchPriority={isActive ? "high" : "low"}
                    decoding="async"
                  />
                ) : null}
                <div
                  className={`${styles.videoTint} ${showControls ? styles.videoTintVisible : ""}`}
                  aria-hidden="true"
                />
                <button
                  className={styles.videoTapTarget}
                  type="button"
                  onClick={() => {
                    if (!isActive) return;
                    setHintVisible(false);
                    setControlsVisible((value) => !value);
                    setMenuVideoId("");
                  }}
                  tabIndex={isActive ? 0 : -1}
                  aria-hidden={!isActive}
                  aria-label={controlsVisible ? `Hide controls for ${video.title}` : `Show controls for ${video.title}`}
                />

                {isActive && (paused || playbackError) ? (
                  <button
                    className={styles.playOverlay}
                    type="button"
                    onClick={retryPlayback}
                    aria-label={playbackError ? "Retry video" : "Play video"}
                  >
                    <Play size={32} fill="currentColor" />
                  </button>
                ) : null}

                {showControls ? <div className={`${styles.videoMeta} ${styles.videoMetaVisible}`}>
                  <Link
                    className={styles.creatorName}
                    href={`/creator?creator=${encodeURIComponent(video.creatorId)}&video=${encodeURIComponent(video.id)}`}
                    aria-label={`View videos by @${video.username}`}
                  >
                    @{video.username}
                  </Link>
                  <h2>{video.title}</h2>
                  {video.description && video.description !== video.title ? (
                    <p>{video.description}</p>
                  ) : null}
                  {video.tags.length ? (
                    <div className={styles.tags}>
                      {video.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                    </div>
                  ) : null}
                  {playbackError ? <p className={styles.playbackStatus} role="alert">{playbackError}</p> : null}
                  {buffering && !paused ? <p className={styles.playbackStatus}>Buffering…</p> : null}
                  {shareStatus ? <p className={styles.playbackStatus} role="status">{shareStatus}</p> : null}
                </div> : null}

                {showControls ? <div className={`${styles.minimalActions} ${styles.minimalActionsVisible}`}>
                  <button
                    className={isSaved ? styles.bookmarkActive : undefined}
                    data-bookmark-control
                    type="button"
                    onClick={() => toggleSaved(video.id)}
                    aria-label={isSaved ? `Remove bookmark for ${video.title}` : `Bookmark ${video.title}`}
                    aria-pressed={isSaved}
                    aria-busy={bookmarks.pendingIds.has(video.id)}
                  >
                    <Bookmark size={21} fill={isSaved ? "currentColor" : "none"} />
                  </button>
                  <button type="button" onClick={() => shareVideo(video)} aria-label={`Share ${video.title}`}>
                    <Share2 size={21} />
                  </button>
                  <button
                    id={`feed-more-${video.id}`}
                    type="button"
                    onClick={() => setMenuVideoId((current) => current === video.id ? "" : video.id)}
                    aria-label={`More actions for ${video.title}`}
                    aria-expanded={menuVideoId === video.id}
                    aria-controls={`feed-menu-${video.id}`}
                  >
                    <MoreHorizontal size={22} />
                  </button>
                  {menuVideoId === video.id ? (
                    <div
                      className={styles.moreMenu}
                      id={`feed-menu-${video.id}`}
                      ref={actionMenuRef}
                      role="group"
                      aria-label={`Actions for ${video.title}`}
                    >
                      <a href={video.sourceUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={17} /> Original post
                      </a>
                      <Link href="/dashboard">
                        <LayoutDashboard size={17} /> Dashboard
                      </Link>
                      <button
                        className={styles.deleteMenuAction}
                        type="button"
                        onClick={() => openDeleteVideo(video)}
                      >
                        <Trash2 size={17} /> Move to trash
                      </button>
                    </div>
                  ) : null}
                </div> : null}

                <div className={styles.progressTrack}>
                  <span ref={isActive ? progressRef : undefined} aria-hidden="true" />
                  <input
                    ref={isActive ? seekRef : undefined}
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    defaultValue="0"
                    disabled={!isActive}
                    tabIndex={isActive ? 0 : -1}
                    aria-label={`Seek ${video.title}`}
                    onPointerDown={() => {
                      scrubbingVideoIdRef.current = video.id;
                    }}
                    onPointerUp={(event) => {
                      if (scrubbingVideoIdRef.current !== video.id) return;
                      scrubbingVideoIdRef.current = "";
                      seekToPercentage(video.id, Number(event.currentTarget.value));
                    }}
                    onLostPointerCapture={() => { scrubbingVideoIdRef.current = ""; }}
                    onInput={(event) => {
                      const percentage = Number(event.currentTarget.value);
                      if (progressRef.current) progressRef.current.style.width = `${percentage}%`;
                      if (scrubbingVideoIdRef.current !== video.id) seekToPercentage(video.id, percentage);
                    }}
                  />
                </div>
              </article>
            );
          })}
          {filteredVideos.length === 0 ? (
            <div className={styles.emptyFeed}>
              <h2>
                {feedView === "bookmarks" && bookmarkError
                  ? "Could not load bookmarks"
                  : bookmarkPagePending
                    ? "Loading bookmarks…"
                  : archive.error
                    ? "Could not load the archive"
                  : archive.source === "loading" || archive.source === "refreshing"
                  ? "Loading videos…"
                  : feedView === "bookmarks" ? "No bookmarks" : "No saved videos"}
              </h2>
              <p role={archive.error || (feedView === "bookmarks" && bookmarkError) ? "alert" : undefined}>
                {feedView === "bookmarks" && bookmarkError
                  ? bookmarkError
                  : archive.error
                  ? archive.error
                  : bookmarkPagePending
                    ? "Loading your server bookmarks."
                  : archive.source === "loading" || archive.source === "refreshing"
                  ? ""
                  : feedView === "bookmarks"
                  ? "Bookmark a video and it will appear here."
                  : "There are no files for this creator."}
              </p>
              <div className={styles.emptyActions}>
                {archive.error && !(feedView === "bookmarks" && bookmarkError) ? (
                  <button type="button" onClick={archive.retry}>Retry</button>
                ) : null}
                {resolvedCreatorId !== "all" ? (
                  <button type="button" onClick={() => selectCreator("all")}>All creators</button>
                ) : null}
                {feedView === "bookmarks" && bookmarkError ? (
                  <button
                    type="button"
                    onClick={retryFeed}
                  >
                    Retry bookmarks
                  </button>
                ) : feedView === "bookmarks" && bookmarksReady && archive.bookmarkedVideosLoaded ? (
                  hasMoreBookmarkedVideos || loadingBookmarkedVideos ? (
                    <button
                      type="button"
                      aria-controls="feed-video-list"
                      aria-busy={loadingBookmarkedVideos}
                      disabled={loadingBookmarkedVideos}
                      onClick={loadNextBookmarkPage}
                    >
                      {loadingBookmarkedVideos ? "Loading more bookmarks…" : "Load more bookmarks"}
                    </button>
                  ) : null
                ) : null}
                <Link href="/dashboard/videos">Open library</Link>
              </div>
            </div>
          ) : null}
          {feedView === "bookmarks"
          && bookmarksReady
          && archive.bookmarkedVideosLoaded
          && !bookmarkError
          && filteredVideos.length > 0 ? (
            <div className={styles.emptyActions}>
              {hasMoreBookmarkedVideos || loadingBookmarkedVideos ? (
                <button
                  type="button"
                  aria-controls="feed-video-list"
                  aria-busy={loadingBookmarkedVideos}
                  disabled={loadingBookmarkedVideos}
                  onClick={loadNextBookmarkPage}
                >
                  {loadingBookmarkedVideos ? "Loading more bookmarks…" : "Load more bookmarks"}
                </button>
              ) : (
                <p role="status">All bookmarks loaded</p>
              )}
            </div>
          ) : null}
        </div>
        {loadingMoreVideos ? (
          <p className="sr-only" role="status">Loading more videos…</p>
        ) : null}
        {feedError && filteredVideos.length > 0 ? (
          <div className={styles.feedToast} role="alert">
            <span id="feed-error-status">{feedError}</span>
            <button
              type="button"
              aria-describedby="feed-error-status"
              aria-label="Retry"
              aria-busy={!bookmarkError && loadingMoreVideos}
              disabled={!bookmarkError && loadingMoreVideos}
              onClick={retryFeed}
            >
              {!bookmarkError && loadingMoreVideos ? <LoaderCircle className={styles.spinning} size={16} aria-hidden="true" /> : "Retry"}
            </button>
          </div>
        ) : feedStatus ? <p className={styles.feedToast} role="status">{feedStatus}</p> : null}
      </section>

      {deleteVideo ? (
        <div
          className={styles.confirmScrim}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deleting) closeDeleteVideo();
          }}
        >
          <section
            className={styles.confirmDialog}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feed-delete-title"
            aria-describedby="feed-delete-description"
          >
            <div className={styles.confirmIcon}><Trash2 size={20} /></div>
            <div>
              <h2 id="feed-delete-title">Move this video to trash?</h2>
              <p id="feed-delete-description">
                <strong>{deleteVideo.title}</strong>
                <span>@{deleteVideo.username} · saved {deleteVideo.savedAtLabel}</span>
                It will leave the active archive now and be permanently deleted after the configured retention period.
              </p>
            </div>
            {deleteError ? <p className={styles.deleteError} role="alert">{deleteError}</p> : null}
            <div className={styles.confirmActions}>
              <button data-dialog-initial type="button" onClick={closeDeleteVideo} disabled={deleting}>
                Cancel
              </button>
              <button
                className={styles.confirmDeleteButton}
                type="button"
                disabled={deleting}
                onClick={() => void confirmDeleteVideo()}
              >
                {deleting ? <LoaderCircle className={styles.spinning} size={16} /> : <Trash2 size={16} />}
                {deleting ? "Moving" : "Move to trash"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function FeedVideo({
  videoId,
  onVideoRef,
  ...props
}: Omit<ComponentProps<"video">, "ref"> & {
  videoId: string;
  onVideoRef: (id: string, node: HTMLVideoElement | null) => void;
}) {
  // A stable ref distinguishes actual removal from a parent's rerender, so
  // retiring a player never clears a buffer that is still on screen.
  const ref = useCallback((node: HTMLVideoElement | null) => onVideoRef(videoId, node), [onVideoRef, videoId]);
  return <video {...props} ref={ref} />;
}

function hasPlaybackBuffer(video: HTMLVideoElement, seconds = PRELOAD_BUFFER_SECONDS): boolean {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return false;
  const bufferedUntil = Math.min(video.duration, video.currentTime + seconds);
  const buffered = video.buffered;
  // WebKit's GStreamer backend can report no ranges after a complete download.
  if (!buffered.length) {
    return video.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA
      && video.networkState === HTMLMediaElement.NETWORK_IDLE;
  }
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= video.currentTime && buffered.end(index) >= bufferedUntil) return true;
  }
  return false;
}

function randomFeedSeed(): number {
  try {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    return value[0] || Date.now();
  } catch {
    return Date.now();
  }
}

function preferredFeedScrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  } catch {
    return "auto";
  }
}

function shuffleVideos(videos: SavedVideo[], seed: number): SavedVideo[] {
  return [...videos].sort((left, right) => {
    const rankDifference = feedRank(left.id, seed) - feedRank(right.id, seed);
    return rankDifference || left.id.localeCompare(right.id);
  });
}

function shuffleVideoPages(videos: SavedVideo[], seed: number, pageSize: number): SavedVideo[] {
  const shuffled: SavedVideo[] = [];
  for (let start = 0; start < videos.length; start += pageSize) {
    shuffled.push(...shuffleVideos(videos.slice(start, start + pageSize), seed ^ start));
  }
  return shuffled;
}

function feedRank(id: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isAutoplayPolicyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError";
}

function shouldIgnoreFeedShortcut(target: EventTarget | null): boolean {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    'input, textarea, select, button, a[href], [role="textbox"], [contenteditable]:not([contenteditable="false"]), [role="dialog"]',
  ));
}
