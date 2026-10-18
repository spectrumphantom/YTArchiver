import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      dbUser?: User;
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in to access your archive" });
    return;
  }
  // This claim preserves the original subject ID for migrated accounts.
  // Never substitute Clerk's native auth.userId for local database lookups.
  const userId = auth.sessionClaims?.userId;
  if (typeof userId !== "string" || !userId) {
    res.status(403).json({ error: "Your account is missing its application identity" });
    return;
  }
  let [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!dbUser) {
    const [inserted] = await db.insert(usersTable).values({ id: userId }).onConflictDoNothing().returning();
    dbUser = inserted;
    if (!dbUser) {
      [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    }
  }
  if (!dbUser) {
    res.status(403).json({ error: "Unable to resolve your application account" });
    return;
  }
  req.dbUser = dbUser;
  next();
};
