import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Download, Square, Pause, CheckCircle, Clock, AlertCircle, Loader2, RefreshCw, ChevronLeft, ChevronRight, ArrowUpDown, LogOut, User } from "lucide-react";
import { useUser, useClerk } from "@clerk/react";
import { Link } from "wouter";
import {
  useScrapePlaylist,
  useGetSongs,
  getGetSongsQueryKey,
  useGetSongStats,
  getGetSongStatsQueryKey,
  useStartDownloads,
  useGetDownloadStatus,
  getGetDownloadStatusQueryKey,
  useStopDownloads,
  usePauseDownloads,
  useStartSongDownload,
  downloadSong,
  getDownloadAllSongsUrl,
  type GetSongsSort,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Utility to format duration in seconds to mm:ss
function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const PAGE_SIZE = 50;

export default function Home() {
  const [url, setUrl] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<GetSongsSort>("added");
  const [pendingSongId, setPendingSongId] = useState<string | null>(null);
  const [savingSongId, setSavingSongId] = useState<string | null>(null);
  const pendingSongTitle = useRef("");
  const wasRunning = useRef(false);
  const saveAllWhenFinished = useRef(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const { signOut } = useClerk();

  const { data: downloadStatus } = useGetDownloadStatus({
    query: {
      queryKey: getGetDownloadStatusQueryKey(),
      refetchInterval: 2000,
    },
  });

  const jobRunning = downloadStatus?.running || false;

  // Queries
  const { data: songPage, isLoading: isLoadingSongs, error: songsError } = useGetSongs(
    { page, pageSize: PAGE_SIZE, sort },
    {
      query: {
        queryKey: getGetSongsQueryKey({ page, pageSize: PAGE_SIZE, sort }),
        refetchInterval: jobRunning ? 3000 : 10000,
        placeholderData: (prev) => prev,
      },
    }
  );

  const songs = songPage?.songs;
  const totalPages = songPage?.totalPages ?? 1;
  const totalSongsCount = songPage?.total ?? 0;

  const { data: stats } = useGetSongStats({
    query: {
      queryKey: getGetSongStatsQueryKey(),
      refetchInterval: jobRunning ? 3000 : 10000,
    },
  });

  const refreshSongs = () => {
    void queryClient.invalidateQueries({ queryKey: getGetSongsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetSongStatsQueryKey() });
  };

  useEffect(() => {
    if (wasRunning.current && !jobRunning) {
      refreshSongs();
      if (saveAllWhenFinished.current) {
        saveAllWhenFinished.current = false;
        if ((downloadStatus?.completed ?? 0) > 0 || (stats?.downloaded ?? 0) > 0) {
          window.location.assign(getDownloadAllSongsUrl());
          if (downloadStatus?.failed) {
            toast({ title: "Some Songs Could Not Be Downloaded", description: `Saving completed tracks. ${downloadStatus.failed} failed tracks can be retried individually.` });
          }
        } else {
          toast({ title: "No Songs Downloaded", description: "YouTube could not provide these tracks. Retry individual songs for another attempt.", variant: "destructive" });
        }
      }
    }
    wasRunning.current = jobRunning;
  }, [jobRunning, downloadStatus, stats, queryClient]);

  const saveSong = async (id: string, title: string) => {
    setSavingSongId(id);
    try {
      const blob = await downloadSong(id);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || id}.mp3`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      toast({ title: "Download Failed", description: err instanceof Error ? err.message : "Unable to save this song.", variant: "destructive" });
    } finally {
      setSavingSongId(null);
    }
  };

  useEffect(() => {
    if (!pendingSongId || jobRunning || !downloadStatus) return;
    setPendingSongId(null);
    if (downloadStatus.completed > 0 && downloadStatus.failed === 0) {
      void saveSong(pendingSongId, pendingSongTitle.current);
    } else {
      toast({ title: "Download Not Completed", description: "The download stopped or YouTube could not provide this track. You can retry it.", variant: "destructive" });
    }
  }, [downloadStatus, jobRunning, pendingSongId]);

  // Mutations
  const scrapePlaylist = useScrapePlaylist({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Scrape Complete",
          description: `Found ${data.totalFound} songs. Added ${data.newAdded} new.`,
        });
        setPage(1);
        setSort("added");
        refreshSongs();
      },
      onError: (err) => {
        toast({
          title: "Scrape Failed",
          description: err.data?.error || err.message || "Unknown error occurred",
          variant: "destructive",
        });
      },
    },
  });

  const startDownloads = useStartDownloads({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetDownloadStatusQueryKey(), data);
        toast({ title: "Downloads Started", description: "Downloading the current playlist one track at a time. A ZIP of the MP3s will save when finished." });
        queryClient.invalidateQueries({ queryKey: getGetDownloadStatusQueryKey() });
        refreshSongs();
      },
      onError: (err) => {
        saveAllWhenFinished.current = false;
        toast({ title: "Downloads Failed", description: err.message, variant: "destructive" });
      },
    },
  });

  const startSongDownload = useStartSongDownload({
    mutation: {
      onSuccess: (data, variables) => {
        queryClient.setQueryData(getGetDownloadStatusQueryKey(), data);
        setPendingSongId(variables.id);
        queryClient.invalidateQueries({ queryKey: getGetDownloadStatusQueryKey() });
        refreshSongs();
        toast({ title: "Downloading Song", description: "The MP3 will save automatically when it is ready." });
      },
      onError: (err) => toast({ title: "Download Failed", description: err.data?.error || err.message, variant: "destructive" }),
    },
  });

  const stopDownloads = useStopDownloads({
    mutation: {
      onSuccess: () => {
        toast({ title: "Downloads Stopped", description: "Aborted current download and halted the queue." });
        queryClient.invalidateQueries({ queryKey: getGetDownloadStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSongStatsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["/api/songs"] });
      },
    },
  });

  const pauseDownloads = usePauseDownloads({
    mutation: {
      onSuccess: () => {
        toast({ title: "Pausing Downloads", description: "Will pause after the current song finishes." });
        queryClient.invalidateQueries({ queryKey: getGetDownloadStatusQueryKey() });
      },
    },
  });

  // Handlers
  const handleScrape = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    scrapePlaylist.mutate({ data: { url: url.trim() } });
  };

  const handleStart = () => {
    if (stats && stats.total > 0 && stats.downloaded === stats.total) {
      window.location.assign(getDownloadAllSongsUrl());
    } else {
      saveAllWhenFinished.current = true;
      startDownloads.mutate();
    }
  };
  const handleStop = () => {
    saveAllWhenFinished.current = false;
    stopDownloads.mutate();
  };
  const handlePause = () => {
    saveAllWhenFinished.current = false;
    pauseDownloads.mutate();
  };
  const handleSortChange = (value: string) => {
    setSort(value as GetSongsSort);
    setPage(1);
  };

  const isDownloading = downloadStatus?.running || false;
  const jobState = downloadStatus?.state ?? "idle";

  // Render Status Badge
  const getStatusBadge = (status: string) => {
    switch (status) {
      case "done":
        return (
          <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20 font-mono">
            <CheckCircle className="w-3 h-3 mr-1" />
            DONE
          </Badge>
        );
      case "error":
        return (
          <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/20 font-mono">
            <AlertCircle className="w-3 h-3 mr-1" />
            ERROR
          </Badge>
        );
      case "downloading":
        return (
          <Badge variant="outline" className="bg-blue-500/10 border-blue-500/20 font-mono animate-pulse-blue">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            DLING
          </Badge>
        );
      default:
      case "pending":
        return (
          <Badge variant="outline" className="bg-muted text-muted-foreground border-muted-foreground/20 font-mono">
            <Clock className="w-3 h-3 mr-1" />
            PENDING
          </Badge>
        );
    }
  };

  const totalSongs = stats?.total || 0;
  const downloadedCount = stats?.downloaded || 0;
  const progressPercent = totalSongs > 0 ? (downloadedCount / totalSongs) * 100 : 0;

  return (
    <div className="playlist-page w-full min-w-0 max-w-6xl mx-auto p-3 sm:p-6 space-y-5 sm:space-y-8">
      {/* Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-mono font-bold tracking-tight text-primary">YT_ARCHIVER</h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">v1.0.0 // PLAYLIST_DOWNLOADER</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
          {user && (
            <div className="flex items-center gap-2">
              {user.imageUrl ? (
                <img src={user.imageUrl} alt="avatar" className="w-6 h-6 rounded-full opacity-80" />
              ) : (
                <User className="w-4 h-4" />
              )}
              <span className="hidden sm:inline max-w-32 truncate">
                {user.firstName ?? user.primaryEmailAddress?.emailAddress ?? "USER"}
              </span>
            </div>
          )}
          <Link href="/account" className="hover:text-foreground">ACCOUNT</Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ redirectUrl: import.meta.env.BASE_URL })}
            className="font-mono text-xs text-muted-foreground hover:text-foreground h-7 px-2"
          >
            <LogOut className="w-3.5 h-3.5 mr-1" />
            LOGOUT
          </Button>
        </div>
      </header>

      {/* Input Section */}
      <form onSubmit={handleScrape} className="flex min-w-0 flex-col sm:flex-row gap-2">
        <Input
          placeholder="PASTE YOUTUBE PLAYLIST URL..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 h-11 font-mono bg-card border-card-border"
          disabled={scrapePlaylist.isPending || jobRunning}
          data-testid="input-playlist-url"
        />
        <Button
          type="submit"
          disabled={scrapePlaylist.isPending || jobRunning || !url.trim()}
          className="h-11 font-mono sm:min-w-[120px]"
          data-testid="button-scrape"
        >
          {scrapePlaylist.isPending ? (
            <>
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              SCRAPING
            </>
          ) : (
            "SCRAPE"
          )}
        </Button>
      </form>
      {jobRunning && (
        <p className="text-xs font-mono text-muted-foreground">
          Pause or stop downloads before switching playlists.
        </p>
      )}
      {scrapePlaylist.isPending && (
        <p role="status" className="text-xs font-mono text-muted-foreground">
          Reading the latest playlist from YouTube. Large playlists may take a minute.
        </p>
      )}
      {scrapePlaylist.data && (
        <p className="break-words text-xs font-mono text-primary">
          CURRENT PLAYLIST: {scrapePlaylist.data.playlistTitle} // {totalSongsCount} TRACKS
        </p>
      )}

      {/* Stats & Controls */}
      <div className="grid min-w-0 grid-cols-1 lg:grid-cols-4 gap-4">
        <Card className="min-w-0 p-4 lg:col-span-3 flex flex-col justify-center space-y-3 bg-card/50">
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-end font-mono text-sm">
            <div className="grid min-w-0 grid-cols-4 gap-3 sm:gap-6">
              <div>
                <span className="text-muted-foreground block text-xs">TOTAL</span>
                <span className="text-lg font-bold" data-testid="text-stat-total">{stats?.total || 0}</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-xs">DONE</span>
                <span className="text-lg font-bold text-green-500" data-testid="text-stat-done">{stats?.downloaded || 0}</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-xs">PENDING</span>
                <span className="text-lg font-bold" data-testid="text-stat-pending">{stats?.pending || 0}</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-xs">ERRORS</span>
                <span className="text-lg font-bold text-red-500" data-testid="text-stat-error">{stats?.error || 0}</span>
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              {progressPercent.toFixed(1)}% COMPLETE
            </div>
          </div>
          <Progress value={progressPercent} className="h-2" />
        </Card>

        <Card className="min-w-0 p-4 flex flex-col justify-center space-y-2 bg-card/50 border-primary/20">
          <div className="text-xs font-mono text-muted-foreground mb-1">JOB_CONTROL</div>
          {!isDownloading ? (
            <Button
              onClick={handleStart}
              disabled={startDownloads.isPending || scrapePlaylist.isPending || !stats?.total}
              className="w-full font-mono bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="button-start-dl"
            >
              <Play className="w-4 h-4 mr-2" />
              {jobState === "paused" ? "RESUME DOWNLOADS" : "DOWNLOAD ALL"}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button
                onClick={handlePause}
                disabled={pauseDownloads.isPending}
                variant="outline"
                className="flex-1 font-mono"
                data-testid="button-pause-dl"
              >
                <Pause className="w-4 h-4 mr-2" /> PAUSE
              </Button>
              <Button
                onClick={handleStop}
                variant="destructive"
                className="flex-1 font-mono"
                data-testid="button-stop-dl"
              >
                <Square className="w-4 h-4 mr-2" /> STOP
              </Button>
            </div>
          )}
          {isDownloading && (
            <div className="text-[10px] font-mono text-blue-400 mt-2 truncate animate-pulse">
              &gt; {downloadStatus?.currentSong || "WAITING..."}
            </div>
          )}
          {!isDownloading && jobState === "paused" && (
            <div className="text-[10px] font-mono text-yellow-400 mt-2 truncate">
              &gt; PAUSED
            </div>
          )}
        </Card>
      </div>

      {/* Data Table */}
      <div className="min-w-0 max-w-full border border-border bg-card">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between border-b border-border px-3 sm:px-4 py-3">
          <span className="text-xs font-mono text-muted-foreground">CURRENT PLAYLIST</span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-11 sm:h-8 font-mono text-xs"
              disabled={!stats?.downloaded}
              onClick={() => window.location.assign(getDownloadAllSongsUrl())}
              title="Save all completed playlist songs together in a ZIP file"
              data-testid="button-save-all"
            >
              <Download className="w-3 h-3 mr-1" /> SAVE ZIP ({stats?.downloaded || 0})
            </Button>
            <ArrowUpDown className="hidden sm:block w-3 h-3 shrink-0 text-muted-foreground" />
            <Select value={sort} onValueChange={handleSortChange}>
              <SelectTrigger className="h-11 sm:h-8 min-w-0 w-full sm:w-[180px] font-mono text-xs" data-testid="select-sort">
                <SelectValue placeholder="SORT BY" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="added" className="font-mono text-xs">PLAYLIST ORDER</SelectItem>
                <SelectItem value="title" className="font-mono text-xs">TITLE (A-Z)</SelectItem>
                <SelectItem value="channel" className="font-mono text-xs">CHANNEL (A-Z)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Table className="playlist-table">
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-[60px]"></TableHead>
              <TableHead className="font-mono text-xs">TITLE</TableHead>
              <TableHead className="font-mono text-xs">CHANNEL</TableHead>
              <TableHead className="font-mono text-xs text-right">DUR</TableHead>
              <TableHead className="font-mono text-xs w-[120px]">STATUS</TableHead>
              <TableHead className="font-mono text-xs w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoadingSongs ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground font-mono">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                  LOADING_MANIFEST...
                </TableCell>
              </TableRow>
            ) : songsError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-red-400 font-mono">
                  Unable to load the playlist. {songsError.message}
                </TableCell>
              </TableRow>
            ) : songs?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground font-mono">
                  NO_RECORDS_FOUND
                </TableCell>
              </TableRow>
            ) : (
              songs?.map((song) => (
                <TableRow key={song.id} className="song-row border-border/50 group" data-testid={`row-song-${song.id}`}>
                  <TableCell className="song-thumbnail">
                    {song.thumbnailUrl ? (
                      <div className="w-12 h-8 bg-muted overflow-hidden">
                        <img src={song.thumbnailUrl} alt={song.title} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                      </div>
                    ) : (
                      <div className="w-12 h-8 bg-muted flex items-center justify-center">
                        <Download className="w-4 h-4 text-muted-foreground" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="song-title font-medium max-w-[300px] truncate" title={song.title}>
                    <span>{song.title}</span>
                    <span className="mt-1 block text-xs font-normal text-muted-foreground sm:hidden">
                      {song.channel} · {formatDuration(song.duration)}
                    </span>
                  </TableCell>
                  <TableCell className="song-channel text-muted-foreground text-sm max-w-[150px] truncate">
                    {song.channel}
                  </TableCell>
                  <TableCell className="song-duration text-right font-mono text-sm text-muted-foreground">
                    {formatDuration(song.duration)}
                  </TableCell>
                  <TableCell className="song-status">
                    {getStatusBadge(song.status)}
                  </TableCell>
                  <TableCell className="song-action">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 sm:h-8 font-mono text-xs text-primary"
                      disabled={savingSongId === song.id || pendingSongId === song.id || (song.status !== "done" && (jobRunning || startSongDownload.isPending))}
                      onClick={() => {
                        if (song.status === "done") void saveSong(song.id, song.title);
                        else {
                          pendingSongTitle.current = song.title;
                          startSongDownload.mutate({ id: song.id });
                        }
                      }}
                      title={song.status === "done" ? "Save MP3 to your device" : "Download this track and save its MP3"}
                      aria-label={`Download ${song.title}`}
                      data-testid={`btn-download-${song.id}`}
                    >
                      {savingSongId === song.id || pendingSongId === song.id || song.status === "downloading"
                        ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                        : <Download className="w-3.5 h-3.5 mr-1" />}
                      {song.status === "done" ? "SAVE MP3" : "DOWNLOAD"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {totalPages > 1 && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-border px-3 sm:px-4 py-3">
            <span className="text-xs font-mono text-muted-foreground" data-testid="text-page-info">
              PAGE {page}/{totalPages} // {totalSongsCount} SONGS
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="font-mono"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                data-testid="button-prev-page"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> PREV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="font-mono"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                data-testid="button-next-page"
              >
                NEXT <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
