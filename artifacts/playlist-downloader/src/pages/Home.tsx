import React, { useState } from "react";
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
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const { signOut } = useClerk();

  const { data: downloadStatus } = useGetDownloadStatus({
    query: {
      queryKey: getGetDownloadStatusQueryKey(),
      refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
    },
  });

  const jobRunning = downloadStatus?.running || false;

  // Queries
  const { data: songPage, isLoading: isLoadingSongs } = useGetSongs(
    { page, pageSize: PAGE_SIZE, sort },
    {
      query: {
        queryKey: getGetSongsQueryKey({ page, pageSize: PAGE_SIZE, sort }),
        refetchInterval: jobRunning ? 3000 : false,
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
      refetchInterval: jobRunning ? 3000 : false,
    },
  });

  // Mutations
  const scrapePlaylist = useScrapePlaylist({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Scrape Complete",
          description: `Found ${data.totalFound} songs. Added ${data.newAdded} new.`,
        });
        setUrl("");
        setPage(1);
        queryClient.invalidateQueries({ queryKey: ["/api/songs"] });
        queryClient.invalidateQueries({ queryKey: getGetSongStatsQueryKey() });
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
      onSuccess: () => {
        toast({ title: "Downloads Started", description: "Beginning bulk download..." });
        queryClient.invalidateQueries({ queryKey: getGetDownloadStatusQueryKey() });
      },
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
    scrapePlaylist.mutate({ data: { url } });
  };

  const handleStart = () => startDownloads.mutate();
  const handleStop = () => stopDownloads.mutate();
  const handlePause = () => pauseDownloads.mutate();
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
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-mono font-bold tracking-tight text-primary">YT_ARCHIVER</h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">v1.0.0 // PLAYLIST_DOWNLOADER</p>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
          {user && (
            <div className="flex items-center gap-2">
              {user.imageUrl ? (
                <img src={user.imageUrl} alt="avatar" className="w-6 h-6 rounded-full opacity-80" />
              ) : (
                <User className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">
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
      <form onSubmit={handleScrape} className="flex gap-2">
        <Input
          placeholder="PASTE YOUTUBE PLAYLIST URL..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="font-mono bg-card border-card-border"
          disabled={scrapePlaylist.isPending}
          data-testid="input-playlist-url"
        />
        <Button
          type="submit"
          disabled={scrapePlaylist.isPending || !url}
          className="font-mono min-w-[120px]"
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

      {/* Stats & Controls */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4 md:col-span-3 flex flex-col justify-center space-y-3 bg-card/50">
          <div className="flex justify-between items-end font-mono text-sm">
            <div className="flex gap-6">
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

        <Card className="p-4 flex flex-col justify-center space-y-2 bg-card/50 border-primary/20">
          <div className="text-xs font-mono text-muted-foreground mb-1">JOB_CONTROL</div>
          {!isDownloading ? (
            <Button
              onClick={handleStart}
              disabled={!stats?.pending || stats.pending === 0}
              className="w-full font-mono bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="button-start-dl"
            >
              <Play className="w-4 h-4 mr-2" />
              {jobState === "paused" ? "RESUME DL" : "START DL"}
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
              &gt; {downloadStatus?.currentSong ? "DOWNLOADING..." : "WAITING..."}
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
      <div className="border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-mono text-muted-foreground">MANIFEST</span>
          <div className="flex items-center gap-2">
            <ArrowUpDown className="w-3 h-3 text-muted-foreground" />
            <Select value={sort} onValueChange={handleSortChange}>
              <SelectTrigger className="h-8 w-[180px] font-mono text-xs" data-testid="select-sort">
                <SelectValue placeholder="SORT BY" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="added" className="font-mono text-xs">DATE ADDED</SelectItem>
                <SelectItem value="title" className="font-mono text-xs">TITLE (A-Z)</SelectItem>
                <SelectItem value="channel" className="font-mono text-xs">CHANNEL (A-Z)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Table>
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
            ) : songs?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground font-mono">
                  NO_RECORDS_FOUND
                </TableCell>
              </TableRow>
            ) : (
              songs?.map((song) => (
                <TableRow key={song.id} className="border-border/50 group" data-testid={`row-song-${song.id}`}>
                  <TableCell>
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
                  <TableCell className="font-medium max-w-[300px] truncate" title={song.title}>
                    {song.title}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[150px] truncate">
                    {song.channel}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    {formatDuration(song.duration)}
                  </TableCell>
                  <TableCell>
                    {getStatusBadge(song.status)}
                  </TableCell>
                  <TableCell>
                    {song.status === "done" && (
                      <a
                        href={`/api/songs/${song.id}/download`}
                        download
                        title="Download MP3"
                        data-testid={`btn-download-${song.id}`}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-primary hover:text-primary hover:bg-primary/10"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </Button>
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
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
