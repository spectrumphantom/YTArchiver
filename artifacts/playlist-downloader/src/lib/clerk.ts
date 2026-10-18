import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";

export const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
export const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

export const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#0ea5e9",
    colorForeground: "#f2f2f2",
    colorMutedForeground: "#a1a1aa",
    colorDanger: "#f87171",
    colorBackground: "#111113",
    colorInput: "#202024",
    colorInputForeground: "#f2f2f2",
    colorNeutral: "#a1a1aa",
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    borderRadius: "0.25rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#111113] rounded-lg w-[440px] max-w-full overflow-hidden border border-border",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-mono",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground",
    formFieldLabel: "text-foreground",
    footerActionLink: "text-primary",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-green-400",
    alertText: "text-foreground",
    logoBox: "justify-center",
    logoImage: "h-12",
    socialButtonsBlockButton: "border-border bg-muted hover:bg-accent",
    formButtonPrimary: "bg-primary text-primary-foreground",
    formFieldInput: "bg-muted text-foreground border-border",
    footerAction: "bg-transparent",
    dividerLine: "bg-border",
    alert: "bg-muted border-border",
    otpCodeFieldInput: "bg-muted text-foreground border-border",
    formFieldRow: "gap-2",
    main: "gap-5",
  },
};
