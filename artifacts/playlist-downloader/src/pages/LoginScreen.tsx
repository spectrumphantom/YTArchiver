import { Link } from "wouter";
import { Lock, Music2, HardDrive, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function LoginScreen() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Subtle grid background */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--primary)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary)) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="relative z-10 w-full max-w-md space-y-10">
        {/* Logo / Brand */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 border border-primary/30 bg-primary/5 mb-2">
            <Music2 className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-4xl font-mono font-bold tracking-tight text-primary">
            YT_ARCHIVER
          </h1>
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">
            v1.0.0 // PLAYLIST_DOWNLOADER
          </p>
        </div>

        {/* Feature list */}
        <div className="border border-border bg-card/50 p-5 space-y-3 font-mono text-sm">
          <div className="text-xs text-muted-foreground mb-4 tracking-widest">SYSTEM_CAPABILITIES</div>
          {[
            { icon: Zap, label: "Bulk download entire playlists as MP3" },
            { icon: HardDrive, label: "Archive to persistent cloud storage" },
            { icon: Music2, label: "Stream & download individual tracks" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-3 text-muted-foreground">
              <Icon className="w-4 h-4 text-primary shrink-0" />
              <span>{label}</span>
            </div>
          ))}
        </div>

        {/* Login CTA */}
        <div className="space-y-4">
          <Button asChild
            size="lg"
            className="w-full font-mono text-base tracking-widest h-12 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Link href="/sign-in">
              <Lock className="w-5 h-5 mr-3" />
              LOG_IN // AUTHENTICATE
            </Link>
          </Button>
          <p className="text-center text-[11px] font-mono text-muted-foreground/60">
            SECURE SIGN-IN — GOOGLE OR EMAIL
          </p>
        </div>
      </div>
    </div>
  );
}
