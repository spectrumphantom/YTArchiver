import { useUser, useClerk } from "@clerk/react";
import { useGetAccount } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { basePath } from "@/lib/clerk";

export default function Account() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { data: account } = useGetAccount();
  return <main className="max-w-2xl mx-auto p-6 space-y-6 font-mono">
    <Link href="/library" className="text-primary">← BACK TO ARCHIVE</Link>
    <h1 className="text-2xl text-primary">YOUR ACCOUNT</h1>
    <p>{user?.fullName || "Archive member"}</p>
    <p>{user?.primaryEmailAddress?.emailAddress}</p>
    {account && <dl data-testid="account-details" className="border border-border p-5 space-y-3">
      <dt className="text-muted-foreground">APPLICATION ACCOUNT</dt><dd data-testid="account-id">{account.id}</dd>
      <dt className="text-muted-foreground">MEMBER SINCE</dt><dd>{new Date(account.createdAt).toLocaleDateString()}</dd>
    </dl>}
    <Button onClick={() => signOut({ redirectUrl: basePath || "/" })}>LOGOUT</Button>
  </main>;
}
