// The marketing page at "/". It shows product content only: nothing here reads the
// API, and no invoice, amount or queue data appears until someone enters the app
// through one of the three entry cards below.
import {
  ArrowRight,
  Bell,
  ChevronDown,
  CreditCard,
  FileText,
  FlaskConical,
  Gavel,
  KeyRound,
  Lock,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { CopyButton } from "../components";
import { Link, navigate } from "../lib";
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

// Illustrative only. No prices, totals or invoice numbers on this page.
const STEPS: { icon: LucideIcon; title: string; text: string; sample: ReactNode }[] = [
  {
    icon: MessageSquare,
    title: "Describe the work",
    text: "Type a one-liner or paste a messy email. The agent extracts the client, line items, amount and terms. If something is missing, it asks instead of guessing.",
    sample: (
      <div className="land-chat">
        <span className="land-chat-who">You</span>
        <span>Bill the studio for last month's brand work, net 15</span>
      </div>
    ),
  },
  {
    icon: FileText,
    title: "Review the draft",
    text: "The draft lands in your approval queue with every figure spelled out. Edit anything, or reject it. Nothing has left Chaser yet.",
    sample: (
      <div className="land-tiers">
        <span className="tag">Draft, waiting for your approval</span>
        <span className="tag tag-outline">Edit</span>
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
          Approve and send
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

// PayPal SANDBOX buyer account, published on purpose so judges can finish a test
// payment. It can only spend sandbox play money.
const SANDBOX_BUYER = {
  email: "sb-him9f53766791@personal.example.com",
  password: "z%$yW+:3",
};

const FLOW = [
  { icon: MessageSquare, who: "You", what: "describe the work in plain language" },
  { icon: FileText, who: "Chaser", what: "drafts the invoice and asks if anything is missing" },
  { icon: ShieldCheck, who: "You", what: "approve it, or edit, or reject" },
  { icon: CreditCard, who: "PayPal", what: "takes the payment and reports it back" },
  { icon: Bell, who: "Chaser", what: "drafts reminders when it's overdue, for your approval" },
];

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const targets = [...root.querySelectorAll<HTMLElement>(".reveal")];
    const show = (el: Element) => el.classList.add("is-visible");
    // Shows anything at or above the reveal line, including sections already scrolled
    // past. Covers browsers without the observer, and the moment after a jump when
    // the observer hasn't reported yet.
    const check = () => {
      const limit = window.innerHeight * 0.92;
      for (const el of targets) {
        if (!el.classList.contains("is-visible") && el.getBoundingClientRect().top < limit) show(el);
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

/**
 * Decorative layers driven by scroll position: the dot grid drifts at half the
 * page's speed, and each dotted "C" turns to its mirror image as its own section
 * passes through the viewport. One passive scroll listener, batched through
 * requestAnimationFrame, so there is at most one style write per element per
 * frame. Under reduced motion everything stays where CSS puts it.
 */
function useScrollEffects(root: React.RefObject<HTMLDivElement | null>) {
  const dots = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dotsEl = dots.current;
    const marks = [...(root.current?.querySelectorAll<HTMLElement>(".land-c") ?? [])];
    if (!dotsEl || marks.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let scheduled = false;
    const update = () => {
      scheduled = false;
      const y = window.scrollY;
      // The tile repeats every 24px, so wrapping at 24px is invisible and the layer
      // never has to be taller than the viewport.
      dotsEl.style.transform = `translate3d(0, ${-((y * 0.5) % 24)}px, 0)`;
      const viewport = window.innerHeight;
      for (const mark of marks) {
        // 0 when the section's top enters at the bottom of the viewport, 1 when its
        // bottom leaves at the top. Clamped, so it never snaps.
        const rect = mark.parentElement!.getBoundingClientRect();
        const progress = Math.min(1, Math.max(0, (viewport - rect.top) / (viewport + rect.height)));
        // The turn happens while the section is arriving (progress 0.1 to 0.35), so the
        // mirrored C is face-on well before the section is centred, and the last section,
        // which can never scroll all the way through, still finishes its turn.
        const turn = Math.min(1, Math.max(0, (progress - 0.1) / 0.25));
        mark.style.transform = `perspective(1400px) rotateY(${(turn * 180).toFixed(2)}deg)`;
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [root]);
  return dots;
}

/**
 * A large "C" made of dots, in the same colour as the grid. Three concentric arcs
 * of circles with a gap on the right. Purely decorative; nothing reads it.
 */
function DottedC({ side }: { side: "left" | "right" }) {
  const size = 520;
  const centre = size / 2;
  const dots: { x: number; y: number }[] = [];
  for (const radius of [224, 202, 180]) {
    // The arc runs from 40° to 320°, leaving the mouth of the C open on the right.
    const span = (280 / 180) * Math.PI;
    const count = Math.round((radius * span) / 20);
    for (let i = 0; i <= count; i++) {
      const angle = (40 / 180) * Math.PI + (span * i) / count;
      dots.push({ x: centre + radius * Math.cos(angle), y: centre + radius * Math.sin(angle) });
    }
  }
  return (
    <div className={`land-c land-c-${side}`} aria-hidden>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {dots.map((dot, index) => (
          <circle key={index} cx={dot.x.toFixed(1)} cy={dot.y.toFixed(1)} r="3.2" />
        ))}
      </svg>
    </div>
  );
}

function scrollToId(id: string) {
  return (event: MouseEvent) => {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };
}

/**
 * DEMO SHORTCUT, NOT AUTHENTICATION. These forms store nothing, check nothing and
 * send nothing: submitting either one just routes to /dashboard. Real multi-user
 * accounts and persistence are out of scope for the hackathon build, and the page
 * tells the person so next to each form.
 */
function enterDemo(event: FormEvent) {
  event.preventDefault();
  navigate("/dashboard");
}

function SignUpCard() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form className="land-card land-entry reveal" onSubmit={enterDemo}>
      <div className="land-entry-head">
        <UserPlus size={18} aria-hidden />
        <h3 className="land-h3">Sign up</h3>
      </div>
      <p className="land-text">Create a workspace for your own clients and invoices.</p>
      <label className="stack">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </label>
      <label className="stack">
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <label className="stack">
        Choose a password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <button type="submit" className="btn land-entry-btn">
        Create account
        <ArrowRight size={14} aria-hidden />
      </button>
      <p className="land-fine">Demo only: nothing you type here is stored or checked.</p>
    </form>
  );
}

function LogInCard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form className="land-card land-entry reveal" onSubmit={enterDemo} style={{ transitionDelay: "70ms" }}>
      <div className="land-entry-head">
        <KeyRound size={18} aria-hidden />
        <h3 className="land-h3">Log in</h3>
      </div>
      <p className="land-text">Back to your dashboard, approval queue and decision log.</p>
      <label className="stack">
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <label className="stack">
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      <button type="submit" className="btn land-entry-btn">
        Log in
        <ArrowRight size={14} aria-hidden />
      </button>
      <p className="land-fine">Demo only: nothing you type here is stored or checked.</p>
    </form>
  );
}

export function Landing() {
  const ref = useReveal();
  const dots = useScrollEffects(ref);

  return (
    <div className="landing" ref={ref}>
      <div className="land-dots" ref={dots} aria-hidden />
      <header className="land-top">
        <div className="land-wrap land-top-row">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden>
              C
            </span>
            Chaser
          </Link>
          <nav className="land-nav" aria-label="Page">
            <a href="#how-it-works" onClick={scrollToId("how-it-works")}>
              How it works
            </a>
            <a href="#safety" onClick={scrollToId("safety")}>
              Safety
            </a>
            <a href="#sandbox" onClick={scrollToId("sandbox")}>
              Sandbox login
            </a>
          </nav>
          <a href="#get-started" className="btn" onClick={scrollToId("get-started")}>
            Get started
            <ArrowRight size={14} aria-hidden />
          </a>
        </div>
      </header>

      <section className="land-hero">
        <div className="land-wrap land-hero-grid">
          <div className="land-hero-copy">
            <p className="land-eyebrow land-enter">AI invoicing and collections, on PayPal</p>
            <h1 className="land-h1 land-enter">Describe the work. Approve the invoice. Get paid faster.</h1>
            <p className="land-lede land-enter">
              An AI agent drafts your invoices and reminders, PayPal takes the payment, and nothing goes out until you approve it.
            </p>
            <div className="land-actions land-enter">
              <a href="#get-started" className="btn btn-primary btn-lg" onClick={scrollToId("get-started")}>
                Get started
                <ArrowRight size={16} aria-hidden />
              </a>
              <a href="#how-it-works" className="btn btn-lg" onClick={scrollToId("how-it-works")}>
                How it works
              </a>
            </div>
          </div>
          <div className="land-flow land-enter" aria-label="How the work moves through Chaser">
            {FLOW.map((node, index) => {
              const Icon = node.icon;
              return (
                <div className="land-flow-node" key={index}>
                  <span className="land-flow-icon">
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className="land-flow-text">
                    <strong>{node.who}</strong> {node.what}
                  </span>
                </div>
              );
            })}
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
        <DottedC side="right" />
        <div className="land-wrap">
          <div className="land-band reveal">
            <p className="land-eyebrow">How it works</p>
            <h2 className="land-h2">Four steps, one click that matters</h2>
            <p className="land-lede">
              Plain language in, a payment request out, and a person in the middle every time.
            </p>
          </div>
          <ol className="land-steps">
            {STEPS.map((step, index) => {
              const Icon = step.icon;
              return (
                <li className="land-card land-step reveal" key={step.title} style={{ transitionDelay: `${index * 70}ms` }}>
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

      <section className="land-section land-section-alt" id="get-started">
        <div className="land-wrap">
          <div className="reveal">
            <p className="land-eyebrow">Get started</p>
            <h2 className="land-h2">Three ways in</h2>
            <p className="land-lede">The judge route needs nothing at all. The other two are the shape of the real product.</p>
          </div>
          <div className="land-card land-judge reveal">
            <div className="land-judge-copy">
              <div className="land-entry-head">
                <Gavel size={20} aria-hidden />
                <h3 className="land-h3 land-judge-title">Continue as judge</h3>
              </div>
              <p className="land-text">
                No account needed. Opens the seeded demo straight away, with clients and invoices in every state, so you can draft, approve, pay and chase in minutes.
              </p>
            </div>
            <Link to="/dashboard" className="btn btn-primary btn-lg land-judge-btn">
              Continue as judge
              <ArrowRight size={16} aria-hidden />
            </Link>
          </div>
          <div className="land-entries">
            <SignUpCard />
            <LogInCard />
          </div>
        </div>
      </section>

      <section className="land-section land-section-tall" id="sandbox">
        <DottedC side="right" />
        <div className="land-wrap land-narrow">
          <div className="reveal">
            <p className="land-eyebrow">For the payment step</p>
            <h2 className="land-h2">PayPal sandbox buyer login</h2>
            <p className="land-lede">
              When you click Pay on an invoice, PayPal's sandbox asks for a buyer account. Use this one.
            </p>
          </div>
          <details className="land-card land-creds reveal">
            <summary>
              <span>Show the sandbox buyer login</span>
              <ChevronDown size={16} aria-hidden />
            </summary>
            <div className="land-creds-body">
              <p className="land-text">Use these when PayPal asks for buyer login during checkout.</p>
              <dl className="land-creds-list">
                <div>
                  <dt>Sandbox buyer email</dt>
                  <dd>
                    <code>{SANDBOX_BUYER.email}</code>
                    <CopyButton text={SANDBOX_BUYER.email} label="Copy" />
                  </dd>
                </div>
                <div>
                  <dt>Sandbox buyer password</dt>
                  <dd>
                    <code>{SANDBOX_BUYER.password}</code>
                    <CopyButton text={SANDBOX_BUYER.password} label="Copy" />
                  </dd>
                </div>
              </dl>
              <p className="land-fine">
                This is a PayPal sandbox test account with play money only. The seller side is a sandbox account too.
              </p>
            </div>
          </details>
        </div>
      </section>

      <section className="land-section land-section-alt" id="safety">
        <div className="land-wrap">
          <div className="reveal">
            <p className="land-eyebrow">Why it's safe</p>
            <h2 className="land-h2">Built so the AI can propose, but never pay</h2>
          </div>
          <ul className="land-safety">
            {SAFETY.map((item, index) => {
              const Icon = item.icon;
              return (
                <li className="land-card land-safe reveal" key={item.title} style={{ transitionDelay: `${index * 70}ms` }}>
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

      <section className="land-section land-section-tall land-cta">
        <DottedC side="left" />
        <div className="land-wrap reveal">
          <h2 className="land-h2">See it run against the PayPal sandbox</h2>
          <p className="land-lede">No password, no setup. The demo is seeded and ready.</p>
          <Link to="/dashboard" className="btn btn-primary btn-lg">
            Continue as judge
            <ArrowRight size={16} aria-hidden />
          </Link>
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
