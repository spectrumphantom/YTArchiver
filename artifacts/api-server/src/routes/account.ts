import { Router } from "express";
import { GetAccountResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";

const router = Router();
router.get("/me", requireAuth, (req, res) => {
  res.json(GetAccountResponse.parse({
    id: req.dbUser!.id,
    createdAt: req.dbUser!.createdAt.toISOString(),
  }));
});
export default router;
