"use client";

import { useState } from "react";

const FORMSPREE_ID = process.env.NEXT_PUBLIC_FORMSPREE_FORM_ID;

type FormState = "idle" | "submitting" | "success" | "error";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "var(--spacing-3) var(--spacing-4)",
  borderRadius: "var(--radius-md)",
  border: "1.5px solid var(--color-border)",
  background: "var(--color-bg)",
  color: "var(--color-text)",
  fontSize: "var(--font-size-base)",
  fontFamily: "inherit",
  outline: "none",
};

export default function ContactForm() {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [formState, setFormState] = useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!FORMSPREE_ID) {
      setErrorMessage("Contact form is not configured. Please try again later.");
      setFormState("error");
      return;
    }

    setFormState("submitting");
    setErrorMessage(null);

    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ message, ...(email ? { email } : {}) }),
      });
      const data = await res.json();
      if (data.ok) {
        setFormState("success");
      } else {
        setErrorMessage(data.error ?? "Something went wrong. Please try again.");
        setFormState("error");
      }
    } catch {
      setErrorMessage("Could not send your message. Check your connection and try again.");
      setFormState("error");
    }
  };

  if (formState === "success") {
    return (
      <div style={{
        background: "var(--color-success-bg)",
        color: "var(--color-success)",
        borderRadius: "var(--radius-md)",
        padding: "var(--spacing-6)",
        textAlign: "center",
      }}>
        <div style={{ fontSize: "2rem", marginBottom: "var(--spacing-3)" }}>✓</div>
        <strong>Message sent.</strong>
        <p style={{ margin: "var(--spacing-2) 0 0", color: "var(--color-success)", fontSize: "var(--font-size-sm)" }}>
          Thanks for the feedback — I read everything.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-4)" }}>
      <div>
        <label htmlFor="message" style={{ display: "block", fontWeight: 600, marginBottom: "var(--spacing-2)", fontSize: "var(--font-size-sm)" }}>
          Message
        </label>
        <textarea
          id="message"
          required
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe the bug or feature idea…"
          style={{ ...inputStyle, resize: "vertical", minHeight: 120 }}
        />
      </div>

      <div>
        <label htmlFor="email" style={{ display: "block", fontWeight: 600, marginBottom: "var(--spacing-2)", fontSize: "var(--font-size-sm)" }}>
          Email{" "}
          <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>
            (optional — only if you&apos;d like a reply)
          </span>
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={inputStyle}
        />
      </div>

      {formState === "error" && (
        <div style={{
          background: "var(--color-error-bg)",
          color: "var(--color-error)",
          padding: "var(--spacing-3) var(--spacing-4)",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--font-size-sm)",
        }}>
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        className="btn btn-primary"
        disabled={formState === "submitting" || !message.trim()}
      >
        {formState === "submitting" ? "Sending…" : "Send"}
      </button>

      <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", margin: 0 }}>
        Messages go directly to the developer and are not stored by this app.
      </p>
    </form>
  );
}
