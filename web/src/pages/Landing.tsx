// The marketing page at "/". Purely a front door: it reads nothing from the API and
// links into the app at /dashboard. Section reveals use IntersectionObserver only.
import {
  ArrowRight,
  Bell,
  CreditCard,
  FileText,
  FlaskConical,
  Lock,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Link } from "../lib";
import "../landing.css";

// Every tag names something the app really does. Sends always need a human click.
const TICKER = [
  "AI-drafted invoices",
  "Human-approved sends",
  "PayPal sandbox payments",
  "Overdue reminders drafted for approval",
  "Risky cases flagged for a human",
  "Full decision log",
  "Webhooks plus a 60-second reconciler",
  "Amounts only from what you wrote",
];

const STEPS: { icon: LucideIcon; title: string; text: string; sample: ReactNode }[] = [
  {
    icon: MessageSquare,
    title: "Describe the work",
    text: "Type a one-liner or paste a messy email. The agent extracts the client, line items, amount and terms. If something is missing, it asks instead of guessing.",
    sample: (
      <div className="land-chat">
        <span className="land-chat-who">You</span>
        <span>Bill Acme $2,400 for March brand work, net 15</span>
      </div>
    ),
  },
  {
    icon: FileText,
    title: "Review the draft",
    text: "The draft lands in your approval queue with every figure spelled out. Edit anything, or reject it. Nothing has left Chaser yet.",
    sample: (
      <div className="land-draft">
        <div>
          <span className="land-draft-kind">Payment request CH-2026-0001</span>
          <strong>Acme</strong>
        </div>
        <div className="land-draft-right">
          <span className="money">$2,400.00</span>
          <span className="tag">Draft</span>
        </div>
      </div>
    ),
  },
  {
    icon: CreditCard,
    title: "Approve and get paid",
    text: "One click creates the PayPal payment request and gives you a link and a message to send. Status updates on its own when the client pays.",
    sample: (
      <div className="land-approve">
        <span className="btn btn-primary land-fake-btn" aria-hidden>
          Approve and send $2,400.00
        </span>
        <span className="tag tag-paid">Paid</span>
      </div>
    ),
  },
  {
    icon: Bell,
    title: "Chase what's overdue",
    text: "Code works out who is late and how late. The agent drafts a friendly, firm or final reminder for you to approve, and flags risky cases for you to handle yourself.",
    sample: (
      <div className="land-tiers">
        <span className="tag">Friendly, days 1 to 7</span>
        <span className="tag tag-attention">Firm, days 8 to 21</span>
        <span className="tag tag-overdue">Final notice, day 22 on</span>
      </div>
    ),
  },
];

const SAFETY: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: ShieldCheck,
    title: "Nothing sends without you",
    text: "The agent's tools can only create proposals. The only code path that sends anything starts from your click on Approve.",
  },
  {
    icon: ScrollText,
    title: "Every decision is logged",
    text: "Each draft, flag, approval and payment is recorded with its reasoning, and you can read the whole log inside the app.",
  },
  {
    icon: Lock,
    title: "Amounts can't be invented",
    text: "Every figure on a draft has to appear in what you typed, and a payment only counts as paid when PayPal's amount matches the invoice.",
  },
  {
    icon: FlaskConical,
    title: "Sandbox only",
    text: "The PayPal sandbox address is hard-coded, and the app refuses to start if pointed anywhere else. No real money moves in this demo.",
  },
];

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const targets = [...root.querySelectorAll<HTMLElement>(".reveal")];
    const show = (el: Element) => el.classList.add("is-visible");
    // Shows anything already in the viewport. Covers browsers without the observer,
    // and the moment after a jump when the observer hasn't reported yet.
    const check = () => {
      const limit = window.innerHeight * 0.92;
      for (const el of targets) {
        if (el.classList.contains("is-visible")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top < limit && rect.bottom > 0) show(el);
      }
    };
    // Only hide sections once we know we can reveal them again.
    root.classList.add("reveal-ready");
    let observer: IntersectionObserver | undefined;
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              show(entry.target);
              observer?.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
      );
      targets.forEach((el) => observer?.observe(el));
    }
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);
  return ref;
}

export function Landing() {
  const ref = useReveal();

  const scrollToHow = (event: MouseEvent) => {
    const target = document.getElementById("how-it-works");
    if (!target) return;
    event.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  return (
    <div className="landing" ref={ref}>
      <header className="land-top">
        <div className="land-wrap land-top-row">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden>
              C
            </span>
            Chaser
          </Link>
          <Link to="/dashboard" className="btn">
            Enter demo
            <ArrowRight size={14} aria-hidden />
          </Link>
        </div>
      </header>

      <section className="land-hero">
        <div className="land-wrap land-hero-grid">
          <div>
            <p className="land-eyebrow">AI invoicing and collections, on PayPal</p>
            <h1 className="land-h1">Describe the work. Approve the invoice. Get paid faster.</h1>
            <p className="land-lede">
              An AI agent drafts your invoices and reminders, PayPal takes the payment, and nothing goes out until you approve it.
            </p>
            <div className="land-actions">
              <Link to="/dashboard" className="btn btn-primary btn-lg">
                Enter demo
                <ArrowRight size={16} aria-hidden />
              </Link>
              <a href="#how-it-works" className="btn btn-lg" onClick={scrollToHow}>
                How it works
              </a>
            </div>
          </div>
          <div className="land-preview" aria-label="Example of an invoice waiting for approval">
            <div className="land-preview-head">
              <span className="land-draft-kind">Approval queue</span>
              <span className="count">1</span>
            </div>
            <div className="land-preview-body">
              <div className="land-draft">
                <div>
                  <span className="land-draft-kind">Payment request CH-2026-0001</span>
                  <strong>Acme</strong>
                </div>
                <div className="land-draft-right">
                  <span className="money land-preview-amount">$2,400.00</span>
                  <span className="tag">Draft</span>
                </div>
              </div>
              <ul className="land-lines">
                <li>
                  <span>March brand work</span>
                  <span className="money">$2,400.00</span>
                </li>
                <li>
                  <span>Payment due</span>
                  <span>Net 15, from the day you approve</span>
                </li>
              </ul>
              <p className="land-preview-note">
                <ShieldCheck size={14} aria-hidden />
                If you approve: creates a PayPal payment page for $2,400.00. No email goes out.
              </p>
              <div className="land-preview-actions" aria-hidden>
                <span className="btn btn-primary land-fake-btn">Approve and send $2,400.00</span>
                <span className="btn land-fake-btn">Edit</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="land-ticker" aria-label="What Chaser does">
        <ul className="land-ticker-track">
          {[...TICKER, ...TICKER].map((item, index) => (
            <li key={index} aria-hidden={index >= TICKER.length}>
              {item}
            </li>
          ))}
        </ul>
      </div>

      <section className="land-section" id="how-it-works">
        <div className="land-wrap">
          <div className="reveal">
            <p className="land-eyebrow">How it works</p>
            <h2 className="land-h2">Four steps, one click that matters</h2>
          </div>
          <ol className="land-steps">
            {STEPS.map((step, index) => {
              const Icon = step.icon;
              return (
                <li className="land-step reveal" key={step.title} style={{ transitionDelay: `${index * 70}ms` }}>
                  <div className="land-step-head">
                    <span className="land-step-num">{index + 1}</span>
                    <Icon size={18} aria-hidden />
                  </div>
                  <h3 className="land-h3">{step.title}</h3>
                  <p className="land-text">{step.text}</p>
                  <div className="land-sample">{step.sample}</div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="land-section land-section-alt">
        <div className="land-wrap">
          <div className="reveal">
            <p className="land-eyebrow">Why it's safe</p>
            <h2 className="land-h2">Built so the AI can propose, but never pay</h2>
          </div>
          <ul className="land-safety">
            {SAFETY.map((item, index) => {
              const Icon = item.icon;
              return (
                <li className="land-safe reveal" key={item.title} style={{ transitionDelay: `${index * 70}ms` }}>
                  <Icon size={18} aria-hidden />
                  <div>
                    <h3 className="land-h3">{item.title}</h3>
                    <p className="land-text">{item.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="land-section land-cta">
        <div className="land-wrap reveal">
          <h2 className="land-h2">See it run against the PayPal sandbox</h2>
          <p className="land-lede">
            The demo is seeded with clients and invoices in every state, so you can draft, approve, pay and chase in minutes.
          </p>
          <Link to="/dashboard" className="btn btn-primary btn-lg">
            Enter demo
            <ArrowRight size={16} aria-hidden />
          </Link>
          <p className="land-note">
            <strong>For judges:</strong> if the demo asks for a login, use any username. The password is the deployment's{" "}
            <code>ADMIN_PASSWORD</code> value, as described in the README. If none is set, no login is needed.
          </p>
        </div>
      </section>

      <footer className="land-foot">
        <div className="land-wrap land-foot-row">
          <span>Chaser. Built for the PayPal × AI hackathon.</span>
          <span>PayPal sandbox only. No real money moves.</span>
        </div>
      </footer>
    </div>
  );
}
