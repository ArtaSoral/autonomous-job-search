"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export default function RefreshButton() {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={refreshing}
      onClick={() => startTransition(() => router.refresh())}
    >
      {refreshing ? "Refreshing…" : "Refresh counts"}
    </button>
  );
}
