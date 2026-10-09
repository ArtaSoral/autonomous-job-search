"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export default function ActionForm({
  action,
  children,
  label = "Save",
  values = {},
}: {
  action: string;
  children?: React.ReactNode;
  label?: string;
  values?: Record<string, unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const router = useRouter();
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        setMessage("");
        const fields = Object.fromEntries(
          new FormData(event.currentTarget).entries(),
        );
        try {
          const response = await fetch("/api/actions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...values, ...fields, action }),
          });
          const result = await response.json();
          if (!response.ok) throw Error(result.error || "Request failed");
          if (result.redirect) router.push(result.redirect);
          else {
            setMessage(result.message || "Saved");
            router.refresh();
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      <div className="row" style={{ marginTop: 14 }}>
        <button disabled={busy}>{busy ? "Working…" : label}</button>
        {message && (
          <span className="muted" role="status">
            {message}
          </span>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
