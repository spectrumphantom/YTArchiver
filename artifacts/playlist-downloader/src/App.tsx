import { Switch, Route, Redirect, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, useClerk, useAuth } from "@clerk/react";
import { useGetAccount, getGetAccountQueryKey } from "@workspace/api-client-react";
import { useEffect, useRef } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clerkPubKey, clerkProxyUrl, clerkAppearance, basePath, stripBase } from "@/lib/clerk";
import Home from "@/pages/Home";
import LoginScreen from "@/pages/LoginScreen";
import Account from "@/pages/Account";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
      client.clear();
    }
    prevUserIdRef.current = userId;
  }), [addListener, client]);
  return null;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <Loading />;
  return isSignedIn ? <Redirect to="/library" /> : <LoginScreen />;
}

function Loading() {
  return <div role="status" className="min-h-screen flex items-center justify-center font-mono text-muted-foreground">LOADING ACCOUNT...</div>;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const account = useGetAccount({ query: { queryKey: getGetAccountQueryKey(), enabled: isLoaded && !!isSignedIn, retry: false } });
  if (!isLoaded) return <Loading />;
  if (!isSignedIn) return <Redirect to="/" />;
  if (account.isError) {
    return <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 font-mono p-6">
      <h1>Account access unavailable</h1>
      <p>{account.error.status === 401 || account.error.status === 403
        ? "Your session could not be linked to an application account."
        : "Your account could not be loaded. Please try again."}</p>
      <button onClick={() => account.refetch()}>Try again</button>
      <button onClick={() => signOut({ redirectUrl: basePath || "/" })}>Log out</button>
    </div>;
  }
  if (!account.data) return <Loading />;
  return <div data-testid="account-resolved">{children}</div>;
}

function SignInPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
  </div>;
}
function SignUpPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
  </div>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      signInFallbackRedirectUrl={`${basePath}/library`}
      signUpFallbackRedirectUrl={`${basePath}/library`}
      localization={{
        signIn: { start: { title: "Welcome back", subtitle: "Sign in to your YT_ARCHIVER account" } },
        signUp: { start: { title: "Create your account", subtitle: "Start archiving your playlists" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/library"><Protected><Home /></Protected></Route>
            <Route path="/account"><Protected><Account /></Protected></Route>
            <Route component={NotFound} />
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  useEffect(() => { document.documentElement.classList.add("dark"); }, []);
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
}
