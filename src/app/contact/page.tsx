import type { Metadata } from "next";
import Link from "next/link";
import ContactForm from "./ContactForm";

export const metadata: Metadata = {
  title: "Contact — Current County",
};

export default function ContactPage() {
  return (
    <div className="prose">
      <Link href="/" className="back-link">← Back</Link>

      <h1>Get in touch</h1>

      <p>
        Current County is a one-person project. If something&apos;s broken or
        you have an idea that would make it better, I want to hear it.
      </p>

      <ContactForm />
    </div>
  );
}
