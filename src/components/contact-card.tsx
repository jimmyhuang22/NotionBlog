"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMenuDismiss } from "./use-dismiss";

function decode(code: string): string {
  try { return new TextDecoder().decode(Uint8Array.from(atob(code), char => char.charCodeAt(0))); } catch { return ""; }
}

/**
 * "联系我" (the owner's pick, 2026-11-18): a trigger that opens a small card with the email address, a button to
 * write and one to copy. The address is only decoded when the card opens (lib/contact.ts), so the page itself
 * carries no address. Two entries share it: the envelope among the profile's icons (card below, centred on the
 * row) and the footer's words (card above). The card is not modal: Escape, a press outside it or the trigger
 * again close it, and focus goes back to the trigger when it was inside. When "写邮件" opens no mail app (the page
 * keeps focus), the card says so and points to copying.
 */
export function ContactCard({ code, place, label, className, children }: { code: string; place: "below" | "above"; label: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  // Set when "写邮件" seemed to open nothing: a machine without a mail app ignores a mailto link without a word.
  const [noMail, setNoMail] = useState(false);
  const mailTimer = useRef(0);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLAnchorElement>(null);
  const address = useRef<HTMLSpanElement>(null);
  const id = useId();
  const email = open ? decode(code) : "";

  const close = () => { setOpen(false); setCopied(""); setNoMail(false); window.clearTimeout(mailTimer.current); };
  useMenuDismiss(open, close, root, trigger, "inside");
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    return () => window.clearTimeout(mailTimer.current);
  }, [open]);

  // A mail app taking over pulls focus from the page; if the page still has it a moment later, nothing opened.
  const write = () => {
    setNoMail(false);
    window.clearTimeout(mailTimer.current);
    const timer = mailTimer.current = window.setTimeout(() => { if (document.hasFocus() && document.visibilityState === "visible") setNoMail(true); }, 1500);
    window.addEventListener("blur", () => window.clearTimeout(timer), { once: true });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(email);
      setCopied("ok");
    } catch {
      // Without the clipboard the address is selected, ready for the reader's own copy.
      const range = document.createRange();
      if (address.current) { range.selectNodeContents(address.current); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); }
      setCopied("fail");
    }
  };

  return (
    <span ref={root} className="contact" data-place={place}>
      <button ref={trigger} type="button" className={className} aria-label={label} title={label} aria-expanded={open} aria-controls={open ? id : undefined} data-platform="email"
        onClick={() => { setOpen(value => !value); setCopied(""); setNoMail(false); }}>{children}</button>
      {open ? (
        <span id={id} className="contact__card" role="dialog" aria-label="联系我">
          <span className="contact__label">邮箱</span>
          <span ref={address} className="contact__address">{email}</span>
          <span className="contact__actions">
            <a ref={first} className="contact__action contact__action--main" href={`mailto:${email}`} onClick={write}>写邮件</a>
            {/* The longest word sits unseen in the same place, so the button and the card keep their size when the word changes. */}
            <button type="button" className="contact__action" onClick={copy}><span className="contact__swap"><span className="contact__sizer" aria-hidden="true">已复制</span><span>{copied === "ok" ? "已复制" : copied === "fail" ? "已选中" : "复制"}</span></span></button>
          </span>
          {noMail && !copied ? <span className="contact__note">没有打开邮件应用？复制地址后用自己的邮箱发就好。</span> : null}
          <span className="visually-hidden" role="status">{copied === "ok" ? "邮箱地址已复制" : copied === "fail" ? "无法自动复制，地址已选中" : noMail ? "没有打开邮件应用，可以复制地址" : ""}</span>
        </span>
      ) : null}
    </span>
  );
}
