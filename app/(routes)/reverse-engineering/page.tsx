'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './ReverseEngineering.module.css';

const sections = [
  { id: 'overview', title: 'Overview', icon: '🎯' },
  { id: 'philosophy', title: 'Philosophy', icon: '💭' },
  { id: 'dlhd', title: 'DLHD Live TV', icon: '📺' },
  { id: '111movies', title: '111movies', icon: '🎬' },
  { id: 'flixer', title: 'Flixer (WASM)', icon: '🔐' },
  { id: 'vidsrc', title: 'VidSrc', icon: '📡' },
  { id: 'uflix', title: 'Uflix', icon: '🌐' },
  { id: 'animekai', title: 'AnimeKai', icon: '🎌' },
  { id: 'megaup', title: 'MegaUp', icon: '🔓' },
  { id: 'hianime', title: 'HiAnime', icon: '🔬' },
  { id: 'viprow', title: 'VIPRow', icon: '🏟️' },
  { id: 'proxy-architecture', title: 'Proxy Architecture', icon: '🔄' },
  { id: 'techniques', title: 'Techniques', icon: '🛠️' },
  { id: 'tools', title: 'Tools', icon: '🧰' },
  { id: 'contribute', title: 'Contributing', icon: '🤝' },
];

const providerStats = [
  { name: 'DLHD', status: 'working', type: 'Live TV', method: 'PoW + Timestamp Validation' },
  { name: '111movies', status: 'disabled', type: 'Movies/TV', method: 'Hash Obfuscation Changed' },
  { name: 'Flixer', status: 'working', type: 'Movies/TV', method: 'WASM Bundling' },
  { name: 'VidSrc', status: 'working', type: 'Movies/TV', method: 'Static Decoders' },
  { name: 'Uflix', status: 'working', type: 'Movies/TV', method: 'gStream API (no encryption)' },
  { name: 'AnimeKai', status: 'working', type: 'Anime', method: 'Native Crypto (183 Tables)' },
  { name: 'MegaUp', status: 'working', type: 'CDN', method: 'UA-Based Stream Cipher' },
  { name: 'HiAnime', status: 'working', type: 'Anime', method: 'TLS Fingerprint Bypass' },
  { name: 'VIPRow', status: 'working', type: 'Live Sports', method: 'Casthill Token Auth' },
  { name: 'PPV', status: 'working', type: 'Pay-Per-View', method: 'Residential Proxy' },
  { name: 'IPTV', status: 'working', type: 'IPTV Portal', method: 'MAC Authentication' },
];

function CodeBlock({ title, code, id, copiedCode, onCopy }: { 
  title: string; 
  code: string; 
  id: string;
  copiedCode: string | null;
  onCopy: (code: string, id: string) => void;
}) {
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span className={styles.codeTitle}>{title}</span>
        <button 
          onClick={() => onCopy(code, id)}
          className={`${styles.copyBtn} ${copiedCode === id ? styles.copied : ''}`}
        >
          {copiedCode === id ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre className={styles.codeContent}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function FlowStep({ num, title, description }: { num: number; title: string; description: string }) {
  return (
    <motion.div 
      className={styles.flowStep}
      initial={{ opacity: 0, x: -20 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      transition={{ delay: num * 0.1 }}
    >
      <div className={styles.stepNum}>{num}</div>
      <div className={styles.stepContent}>
        <h4>{title}</h4>
        <p>{description}</p>
      </div>
    </motion.div>
  );
}

function ProviderCard({ name, type, method, delay, status }: { 
  name: string; 
  type: string; 
  method: string;
  delay: number;
  status: string;
}) {
  const isDisabled = status === 'disabled';
  return (
    <motion.div 
      className={`${styles.providerCard} ${isDisabled ? styles.providerDisabled : ''}`}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay }}
      whileHover={{ scale: 1.02, y: -5 }}
    >
      <div className={`${styles.providerStatus} ${isDisabled ? styles.statusDisabled : ''}`}>
        <span className={`${styles.statusDot} ${isDisabled ? styles.statusDotDisabled : ''}`} />
        {isDisabled ? 'Disabled' : 'Working'}
      </div>
      <h3>{name}</h3>
      <div className={styles.providerMeta}>
        <span className={styles.providerType}>{type}</span>
        <span className={styles.providerMethod}>{method}</span>
      </div>
    </motion.div>
  );
}

export default function ReverseEngineeringPage() {
  const [activeSection, setActiveSection] = useState('overview');
  const [progress, setProgress] = useState(0);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress((scrollTop / docHeight) * 100);

      for (const section of sections) {
        const el = document.getElementById(section.id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 150 && rect.bottom > 150) {
            setActiveSection(section.id);
            break;
          }
        }
      }
    };

    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const copyCode = (code: string, id: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(id);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setMobileNavOpen(false);
  };

  return (
    <div className={styles.page}>
      <div className={styles.progressBar} style={{ width: `${progress}%` }} />
      
      <div className={styles.bgEffects}>
        <div className={styles.bgOrb1} />
        <div className={styles.bgOrb2} />
        <div className={styles.bgOrb3} />
        <div className={styles.bgGrid} />
      </div>

      {/* Hero Section */}
      <header className={styles.hero}>
        <motion.div 
          className={styles.heroContent}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
        >
          <Link href="/about" className={styles.backLink}>
            <span>←</span> Back to About
          </Link>
          
          <motion.div 
            className={styles.badge}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.2 }}
          >
            <span className={styles.badgeDot} />
            Technical Documentation • March 2026
          </motion.div>
          
          <h1 className={styles.heroTitle}>
            <span className={styles.titleGradient}>Reverse Engineering</span>
            <br />
            <span className={styles.titleSecondary}>Streaming Providers</span>
          </h1>
          
          <p className={styles.heroSubtitle}>
            A comprehensive guide to bypassing embed protections and extracting clean m3u8 streams 
            without ads, popups, or malware. Updated March 2026 with 11 providers, TLS fingerprint 
            bypass, live sports extraction, IPTV portal auth, and the unified Provider Registry.
          </p>

          <motion.div 
            className={styles.warningBox}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            <div className={styles.warningIcon}>⚠️</div>
            <div className={styles.warningContent}>
              <strong>Educational Purpose Only</strong>
              <p>
                This documentation demonstrates how streaming site protections work. 
                Use this knowledge responsibly.
              </p>
            </div>
          </motion.div>

          <motion.div 
            className={styles.quickStats}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
          >
            <div className={styles.stat}>
              <span className={styles.statNum}>10/11</span>
              <span className={styles.statLabel}>Providers Working</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statNum}>91%</span>
              <span className={styles.statLabel}>Success Rate</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statNum}>0</span>
              <span className={styles.statLabel}>Browser Automation</span>
            </div>
          </motion.div>
        </motion.div>
      </header>

      {/* Mobile Nav Toggle */}
      <button 
        className={styles.mobileNavToggle}
        onClick={() => setMobileNavOpen(!mobileNavOpen)}
      >
        <span className={styles.navIcon}>☰</span>
        <span>{sections.find(s => s.id === activeSection)?.title}</span>
        <span className={styles.navProgress}>{Math.round(progress)}%</span>
      </button>

      <AnimatePresence>
        {mobileNavOpen && (
          <motion.div 
            className={styles.mobileNavOverlay}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setMobileNavOpen(false)}
          >
            <motion.nav 
              className={styles.mobileNav}
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              onClick={e => e.stopPropagation()}
            >
              <div className={styles.mobileNavHeader}>
                <span>Contents</span>
                <button onClick={() => setMobileNavOpen(false)}>✕</button>
              </div>
              {sections.map((s) => (
                <button
                  key={s.id}
                  className={`${styles.mobileNavItem} ${activeSection === s.id ? styles.active : ''}`}
                  onClick={() => scrollToSection(s.id)}
                >
                  <span className={styles.navItemIcon}>{s.icon}</span>
                  {s.title}
                </button>
              ))}
            </motion.nav>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Layout */}
      <div className={styles.layout}>
        <nav className={styles.sidebar}>
          <div className={styles.sidebarInner}>
            <div className={styles.sidebarHeader}>
              <span>Contents</span>
              <span className={styles.sidebarProgress}>{Math.round(progress)}%</span>
            </div>
            {sections.map((s, i) => (
              <button
                key={s.id}
                className={`${styles.navItem} ${activeSection === s.id ? styles.active : ''}`}
                onClick={() => scrollToSection(s.id)}
              >
                <span className={styles.navNum}>{String(i + 1).padStart(2, '0')}</span>
                <span className={styles.navItemIcon}>{s.icon}</span>
                <span className={styles.navItemTitle}>{s.title}</span>
              </button>
            ))}
          </div>
        </nav>

        <main className={styles.content} ref={contentRef}>

          {/* Overview */}
          <section id="overview" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🎯</span>
                Overview
              </h2>
              
              <p className={styles.lead}>
                Most &quot;free&quot; streaming sites wrap their content in layers of obfuscation, 
                aggressive advertising, and sometimes outright malware. But here&apos;s the thing: 
                the actual video streams are just standard HLS (m3u8) files.
              </p>
              
              <p>
                By reverse engineering these protections, we can extract the clean stream URLs and 
                play them in our own player—no ads, no popups, no cryptocurrency miners. As of 
                March 2026, we&apos;ve cracked 11 providers through a unified Provider Registry 
                including PoW authentication, WASM binaries, 183-table substitution ciphers, TLS 
                fingerprint bypass, live sports token auth, and IPTV portal MAC authentication.
              </p>

              <div className={styles.providerGrid}>
                {providerStats.map((provider, i) => (
                  <ProviderCard key={provider.name} {...provider} delay={i * 0.08} />
                ))}
              </div>
            </motion.div>
          </section>

          {/* Philosophy */}
          <section id="philosophy" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>💭</span>
                Philosophy: On the Ethics of Robbing Pirates
              </h2>
              
              <h3>The Moral Quandary (Or Lack Thereof)</h3>
              <p>
                Let us address the elephant in the room: Is it ethical to reverse engineer pirate 
                streaming sites? To which we respond: Is it ethical to profit from content you don&apos;t 
                own by wrapping it in malware and cryptocurrency miners?
              </p>
              
              <p>
                The streaming sites we reverse engineer are not legitimate businesses—they do not 
                license content, pay creators, or contribute to the creative economy. Instead, they 
                aggregate stolen content and monetize it through malicious advertising, browser 
                hijacking, and computational theft via cryptocurrency mining.
              </p>

              <p>
                In essence, they are pirates. And we are pirates who rob pirates. It&apos;s like being 
                Robin Hood, except instead of stealing from the rich to give to the poor, we&apos;re 
                stealing from people who are already stealing, and giving to anyone who wants a stream 
                without seventeen pop-ups.
              </p>
              
              <blockquote className={styles.quote}>
                <p>
                  &quot;We are not stealing from creators. We are bypassing the middlemen who were 
                  already stealing from creators. It&apos;s piracy all the way down, and we&apos;re 
                  just cutting out the most exploitative layer.&quot;
                </p>
                <cite>- The Pirate&apos;s Code, Article 3, Subsection B</cite>
              </blockquote>

              <h3>The Rules of Engagement</h3>
              <div className={styles.rulesList}>
                <div className={styles.rule}>
                  <span className={styles.ruleIcon}>🚫</span>
                  <div>
                    <strong>No Puppeteer/Browser Automation</strong>
                    <p>If we need a headless browser, we haven&apos;t properly reverse engineered it. 
                    Pure HTTP requests only.</p>
                  </div>
                </div>
                <div className={styles.rule}>
                  <span className={styles.ruleIcon}>🎬</span>
                  <div>
                    <strong>No Embedding Their Players</strong>
                    <p>Their players contain ads, tracking, and probably a cryptocurrency miner or two. 
                    We extract the stream URL and use our own player.</p>
                  </div>
                </div>
                <div className={styles.rule}>
                  <span className={styles.ruleIcon}>📝</span>
                  <div>
                    <strong>Document Everything</strong>
                    <p>Knowledge should be shared. If we crack an obfuscation method, we document it 
                    so others can learn.</p>
                  </div>
                </div>
                <div className={styles.rule}>
                  <span className={styles.ruleIcon}>💰</span>
                  <div>
                    <strong>Zero Profit Motive</strong>
                    <p>We generate no revenue. No ads, no subscriptions, no donations. Purely 
                    educational and ethical.</p>
                  </div>
                </div>
              </div>
            </motion.div>
          </section>

          {/* DLHD */}
          <section id="dlhd" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>📺</span>
                DLHD Live TV
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Fully Reverse Engineered - PoW + Timestamp + Server-Side Decryption
              </div>
              
              <h3>Overview</h3>
              <p>
                DLHD provides 850+ live TV streams using HLS with AES-128 encryption. They use 
                Proof-of-Work authentication with HMAC-SHA256 + MD5 nonce computation. The twist: 
                timestamps must be 5-10 seconds in the past. A dedicated Cloudflare Worker handles 
                the entire pipeline including server-side segment decryption.
              </p>

              <h3>The Security Timeline</h3>
              <div className={styles.flowContainer}>
                <FlowStep num={1} title="January 16: PoW Authentication" description="Added HMAC-SHA256 + MD5 nonce computation. Domain changed to dvalna.ru." />
                <FlowStep num={2} title="January 21: Timestamp Validation" description="Timestamps must be 5-10 seconds in the past. Current time fails with E11 error." />
                <FlowStep num={3} title="January 22: Server Discovery" description="Found missing servers (dokko1, ddy6). Multiple backends per channel." />
                <FlowStep num={4} title="February: Backend Switching" description="Obfuscated backend IDs. Client never sees actual server names. Resolution happens server-side." />
              </div>

              <h3>The PoW Algorithm</h3>
              <CodeBlock 
                title="Proof-of-Work Nonce Computation"
                id="dlhd-pow"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`// CORRECT SECRET - extracted from WASM module (January 2026)
const HMAC_SECRET = '444c44cc8888888844444444';
const POW_THRESHOLD = 0x1000;

function computePoWNonce(resource, keyNumber, timestamp) {
  const hmac = HMAC_SHA256(resource, HMAC_SECRET);
  
  for (let nonce = 0; nonce < 100000; nonce++) {
    const data = hmac + resource + keyNumber + timestamp + nonce;
    const hash = MD5(data);
    const prefix = parseInt(hash.substring(0, 4), 16);
    
    if (prefix < POW_THRESHOLD) return nonce;
  }
  return null;
}`}
              />

              <h3>Critical: Timestamp Must Be in the Past</h3>
              <CodeBlock 
                title="Timestamp Validation (5-10 seconds in the past)"
                id="dlhd-timestamp"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`// CRITICAL: DLHD requires timestamp to be 5-10 seconds in the past
// Using current time returns: {"error":"E11","message":"Timestamp out of range"}

// ❌ FAILS: Current time
const timestamp = Math.floor(Date.now() / 1000);

// ✅ WORKS: 7 seconds in the past (middle of acceptable range)
const timestamp = Math.floor(Date.now() / 1000) - 7;`}
              />

              <h3>Dedicated Worker Architecture</h3>
              <p>
                The DLHD extractor runs as a dedicated Cloudflare Worker at <code>dlhd.vynx-3b3.workers.dev</code>. 
                The <code>/play/:channelId</code> endpoint handles everything: JWT generation, M3U8 fetch, 
                URL rewriting, and AES-128 segment decryption server-side. The client just plays the 
                proxied m3u8.
              </p>

              <h3>Error Codes</h3>
              <div className={styles.errorCodes}>
                <div className={styles.errorCode}>
                  <span className={styles.errorBadge}>E9</span>
                  <div>
                    <code>Missing required headers</code>
                    <p>PoW headers not provided</p>
                  </div>
                </div>
                <div className={styles.errorCode}>
                  <span className={styles.errorBadge}>E11</span>
                  <div>
                    <code>Timestamp out of range</code>
                    <p>Timestamp too recent or too old. Use current_time - 7 seconds.</p>
                  </div>
                </div>
              </div>

              <blockquote className={styles.quote}>
                <p>
                  &quot;DLHD updated their security three times in January 2026. Each time we cracked 
                  it within hours. The cat-and-mouse game continues, but our architecture absorbs 
                  the changes—only the DLHD adapter needs updating.&quot;
                </p>
                <cite>- Field Notes, January 2026</cite>
              </blockquote>
            </motion.div>
          </section>

          {/* 111movies */}
          <section id="111movies" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🎬</span>
                111movies (1movies)
              </h2>
              
              <div className={`${styles.statusBadge}`} style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }}>
                <span className={styles.statusDot} style={{ background: '#ef4444', boxShadow: '0 0 10px rgba(239, 68, 68, 0.5)' }} />
                Disabled - Hash Obfuscation Changed
              </div>
              
              <h3>Overview</h3>
              <p>
                111movies uses a Next.js frontend with a sophisticated encoding scheme: AES-256-CBC 
                encryption, XOR obfuscation, and custom alphabet substitution. Five layers of 
                obfuscation in total. Currently disabled as they changed their hash obfuscation, 
                but the extraction method is documented for reference.
              </p>

              <h3>The Algorithm (5 Layers)</h3>
              <div className={styles.flowContainer}>
                <FlowStep num={1} title="Extract Page Data" description="Fetch __NEXT_DATA__.props.pageProps.data from page" />
                <FlowStep num={2} title="AES-256-CBC Encrypt" description="Encrypt with static key and IV, output as hex" />
                <FlowStep num={3} title="XOR Obfuscation" description="XOR each character with 9-byte rotating key" />
                <FlowStep num={4} title="Base64 Encode" description="UTF-8 encode, then Base64 with URL-safe characters" />
                <FlowStep num={5} title="Alphabet Substitution" description="Replace each character using shuffled alphabet" />
              </div>

              <h3>Extracted Keys</h3>
              <CodeBlock 
                title="AES Key (32 bytes) + XOR Key (9 bytes)"
                id="111-keys"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`const AES_KEY = Buffer.from([
  3, 75, 207, 198, 39, 85, 65, 255,
  64, 89, 191, 251, 35, 214, 209, 210,
  62, 164, 155, 85, 247, 158, 167, 48,
  172, 84, 13, 18, 19, 166, 19, 57
]);

const XOR_KEY = Buffer.from([170, 162, 126, 126, 60, 255, 136, 130, 133]);

const STANDARD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const SHUFFLED = "TuzHOxl7b0RW9o_1FPV3eGfmL4Z5pD8cahBQr2U-6yvEYwngXCdJjANtqKIMiSks";`}
              />

              <p>
                <strong>Note:</strong> Their CDN uses Cloudflare Workers (<code>p.XXXXX.workers.dev</code>) 
                that block other Cloudflare Workers. Requires residential proxy via the <code>/animekai</code> 
                CF Worker route.
              </p>
            </motion.div>
          </section>

          {/* Flixer */}
          <section id="flixer" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🔐</span>
                Flixer / Hexa - WASM Cracking
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Fully Reverse Engineered - WASM Bundled in CF Worker
              </div>
              
              <h3>Overview</h3>
              <p>
                Flixer.sh uses a Rust-compiled WebAssembly module for key generation and AES-256-CTR 
                encryption with HMAC authentication. After a 12-hour reverse engineering session 
                involving Ghidra, memory forensics, and ~150 test scripts, we cracked it at 2 AM on 
                December 21, 2025.
              </p>

              <h3>The Challenge</h3>
              <div className={styles.challengeGrid}>
                <div className={styles.challengeItem}>
                  <span className={styles.challengeIcon}>🔒</span>
                  <strong>WASM Encryption</strong>
                  <p>All API responses encrypted with AES-256-CTR</p>
                </div>
                <div className={styles.challengeItem}>
                  <span className={styles.challengeIcon}>🖥️</span>
                  <strong>Browser Fingerprinting</strong>
                  <p>Keys derived from screen, UA, timezone, canvas</p>
                </div>
                <div className={styles.challengeItem}>
                  <span className={styles.challengeIcon}>🔑</span>
                  <strong>Session Binding</strong>
                  <p>Each session generates unique 64-char hex key</p>
                </div>
                <div className={styles.challengeItem}>
                  <span className={styles.challengeIcon}>✅</span>
                  <strong>HMAC Authentication</strong>
                  <p>Requests require HMAC-SHA256 signatures</p>
                </div>
              </div>

              <h3>The Breakthrough: WASM Bundling</h3>
              <p>
                Instead of cracking the algorithm, we bundle their WASM binary directly into our 
                Cloudflare Worker. The key insight: WASM runs anywhere that provides the expected 
                browser APIs. We mock those APIs server-side.
              </p>

              <CodeBlock 
                title="WASM Import Mocking"
                id="flixer-mock"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`const mockWindow = {
  document: {
    createElement: (tag) => tag === 'canvas' ? mockCanvas : {},
    getElementsByTagName: (tag) => tag === 'body' ? [mockBody] : [],
  },
  localStorage: {
    getItem: (key) => key === 'tmdb_session_id' ? sessionId : null,
    setItem: () => {},
  },
  navigator: { platform: 'Win32', language: 'en-US', userAgent: '...' },
  screen: { width: 1920, height: 1080, colorDepth: 24 },
  performance: { now: () => Date.now() - timestamp },
};`}
              />

              <h3>Batch Extraction</h3>
              <p>
                The CF Worker supports <code>/flixer/extract-all</code> which fans out to all 12 
                Flixer servers in parallel internally, avoiding 12 separate round-trips through the 
                RPI proxy. Flixer CDN (<code>p.XXXXX.workers.dev</code>) blocks CF Worker IPs, so 
                streams route through the dedicated <code>/flixer/stream</code> endpoint.
              </p>

              <blockquote className={styles.quote}>
                <p>
                  &quot;Sometimes the best way to crack encryption is to not crack it at all. Just run 
                  their code in your environment with mocked inputs. If you can&apos;t beat the algorithm, 
                  become the algorithm.&quot;
                </p>
                <cite>- Field Notes, December 21, 2025, 2:00 AM</cite>
              </blockquote>
            </motion.div>
          </section>

          {/* VidSrc */}
          <section id="vidsrc" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>📡</span>
                VidSrc - Static Decoders
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Working - Primary Provider
              </div>
              
              <h3>Encoding Formats</h3>
              <CodeBlock 
                title="HEX Format (Primary)"
                id="vidsrc-hex"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`// Algorithm: Reverse → Subtract 1 from each char → Hex decode
function decodeHexFormat(encoded) {
  const reversed = encoded.split('').reverse().join('');
  let adjusted = '';
  for (let i = 0; i < reversed.length; i++) {
    adjusted += String.fromCharCode(reversed.charCodeAt(i) - 1);
  }
  const hexClean = adjusted.replace(/[^0-9a-fA-F]/g, '');
  let decoded = '';
  for (let i = 0; i < hexClean.length; i += 2) {
    decoded += String.fromCharCode(parseInt(hexClean.substr(i, 2), 16));
  }
  return decoded;
}`}
              />
              <p>
                VidSrc CDN domains require residential proxy. Streams route through the 
                <code>/animekai</code> CF Worker route which detects VidSrc domains and forwards 
                to the RPI&apos;s dedicated <code>/vidsrc/stream</code> endpoint.
              </p>
            </motion.div>
          </section>

          {/* Uflix */}
          <section id="uflix" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🌍</span>
                VidLink - Multi-Language
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Working - 17 Servers, 8 Languages
              </div>
              
              <h3>Available Servers</h3>
              <div className={styles.serverGrid}>
                <div className={styles.serverGroup}>
                  <h4>English Servers</h4>
                  <div className={styles.serverList}>
                    <span>Neon</span><span>Sage</span><span>Cypher</span><span>Yoru</span>
                    <span>Reyna</span><span>Omen</span><span>Breach</span><span>Vyse</span>
                  </div>
                </div>
                <div className={styles.serverGroup}>
                  <h4>International</h4>
                  <div className={styles.serverList}>
                    <span>🇩🇪 German</span><span>🇮🇹 Italian</span><span>🇫🇷 French</span>
                    <span>🇪🇸 Spanish</span><span>🇧🇷 Portuguese</span>
                  </div>
                </div>
              </div>
              <p>
                VidLink uses AES-256-CBC encryption. CDN domain <code>vodvidl.site</code> requires 
                residential proxy. Routes through CF Worker → RPI&apos;s <code>/vidlink/stream</code> 
                endpoint with correct headers.
              </p>
            </motion.div>
          </section>

          {/* AnimeKai */}
          <section id="animekai" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🎌</span>
                AnimeKai - Native Crypto Breakthrough
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Fully Reverse Engineered - 183 Substitution Tables
              </div>
              
              <h3>Overview</h3>
              <p>
                AnimeKai uses a position-dependent substitution cipher with 183 unique tables—one 
                for each character position. We reverse engineered all tables and now have 100% 
                native encryption/decryption with zero external dependencies. Priority 30 in the 
                Provider Registry (primary anime provider).
              </p>

              <h3>Cipher Structure</h3>
              <div className={styles.flowContainer}>
                <FlowStep num={1} title="21-Byte Header" description="Fixed header: c509bdb497cbc06873ff412af12fd8007624c29faa (hex)" />
                <FlowStep num={2} title="Constant Padding" description="Positions 1,2,3,4,5,6,8,9,10,12,14,16,18 have fixed values" />
                <FlowStep num={3} title="Position Mapping" description="Plaintext position 0→0, 1→7, 2→11, 3→13, 4→15, 5→17, 6→19, 7+→20+" />
                <FlowStep num={4} title="Substitution Tables" description="183 tables, each mapping 78 characters to unique bytes" />
                <FlowStep num={5} title="URL-Safe Base64" description="Output encoded with - and _ instead of + and /" />
              </div>

              <h3>Native Encryption</h3>
              <CodeBlock 
                title="encryptKai() Implementation"
                id="animekai-encrypt"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`export function encryptKai(plaintext: string): string {
  const result = Buffer.alloc(HEADER_LEN + 20 + plaintext.length);
  HEADER.copy(result, 0);
  
  // Fill constant padding bytes
  for (const [pos, val] of Object.entries(CONSTANT_BYTES)) {
    result[HEADER_LEN + parseInt(pos)] = val;
  }
  
  // Encrypt each character using position-specific table
  for (let i = 0; i < plaintext.length; i++) {
    const char = plaintext[i];
    const table = ENCRYPT_TABLES[i];
    const cipherPos = getCipherPosition(i);
    result[HEADER_LEN + cipherPos] = table[char] ?? 0xd4;
  }
  
  return urlSafeBase64Encode(result);
}`}
              />

              <h3>Complete API Flow</h3>
              <div className={styles.flowContainer}>
                <FlowStep num={1} title="ID Mapping" description="TMDB ID → MAL/AniList ID via ARM API" />
                <FlowStep num={2} title="Search" description="encryptKai(malId) → POST /ajax/anime/search" />
                <FlowStep num={3} title="Episodes" description="encryptKai(kai_id) → GET /ajax/episodes" />
                <FlowStep num={4} title="Servers" description="encryptKai(token) → GET /ajax/links (sub/dub)" />
                <FlowStep num={5} title="Embed URL" description="encryptKai(lid) → decryptKai(response) → MegaUp URL" />
                <FlowStep num={6} title="Stream" description="MegaUp URL → native decryption → HLS m3u8" />
              </div>

              <blockquote className={styles.quote}>
                <p>
                  &quot;The cipher looked complex at first—183 different substitution tables! But once 
                  we realized it was position-dependent with no key derivation, building the tables 
                  was just tedious, not hard. Weeks of work, but conceptually simple.&quot;
                </p>
                <cite>- Field Notes, December 2025</cite>
              </blockquote>
            </motion.div>
          </section>

          {/* MegaUp */}
          <section id="megaup" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🔓</span>
                MegaUp - Stream Cipher Cracked
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Fully Reverse Engineered - Pre-computed Keystream
              </div>
              
              <h3>Overview</h3>
              <p>
                MegaUp is the CDN used by AnimeKai. Their <code>/media/</code> endpoint returns 
                encrypted JSON. Key insight: For a fixed User-Agent, the keystream is constant. 
                We pre-computed a 521-byte keystream for our fixed UA.
              </p>

              <h3>Native Decryption</h3>
              <CodeBlock 
                title="decryptMegaUp() - XOR with Pre-computed Keystream"
                id="megaup-decrypt"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`export function decryptMegaUp(encryptedBase64: string): string {
  const keystream = Buffer.from(MEGAUP_KEYSTREAM_HEX, 'hex');
  
  // Convert from URL-safe base64
  const base64 = encryptedBase64.replace(/-/g, '+').replace(/_/g, '/');
  const encBytes = Buffer.from(base64, 'base64');
  
  // XOR decrypt with pre-computed keystream
  const decBytes = Buffer.alloc(encBytes.length);
  for (let i = 0; i < encBytes.length; i++) {
    decBytes[i] = encBytes[i] ^ keystream[i];
  }
  
  return decBytes.toString('utf8');
}`}
              />

              <p>
                MegaUp CDN domains (<code>hub26link.site</code>, <code>dev23app.site</code>, 
                <code>net22lab.site</code>, <code>app28base.site</code>, etc.) all block datacenter 
                IPs. All requests route through the <code>/animekai</code> CF Worker route → RPI 
                residential proxy.
              </p>

              <blockquote className={styles.quote}>
                <p>
                  &quot;We spent days trying to reverse engineer the full keystream generation algorithm. 
                  Then realized: if the keystream is constant for a fixed UA, we don&apos;t need to 
                  understand HOW it&apos;s generated—just WHAT it is. Pre-compute once, use forever.&quot;
                </p>
                <cite>- Field Notes, December 2025</cite>
              </blockquote>
            </motion.div>
          </section>

          {/* HiAnime - NEW */}
          <section id="hianime" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🔬</span>
                HiAnime / MegaCloud - TLS Fingerprint Bypass
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Working - Fallback Anime Provider (Priority 35)
              </div>
              
              <h3>Overview</h3>
              <p>
                HiAnime is the secondary anime provider (priority 35, after AnimeKai at 30). It uses 
                MegaCloud CDN which employs TLS fingerprinting to detect non-browser clients. Standard 
                Node.js/fetch requests get blocked even with correct headers—the CDN checks the TLS 
                handshake itself.
              </p>

              <h3>The TLS Fingerprint Problem</h3>
              <p>
                MegaCloud CDN domains (<code>rabbitstream</code>, <code>vidcloud</code>, 
                <code>dokicloud</code>, <code>megacloud.blog</code>) use JA3/JA4 TLS fingerprinting. 
                This means they can distinguish between a real Chrome browser and a Node.js HTTP client 
                at the TLS layer, before any HTTP headers are even sent.
              </p>

              <h3>The Solution: curl-impersonate</h3>
              <CodeBlock 
                title="RPI Proxy with TLS Fingerprint Impersonation"
                id="hianime-tls"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`// The /hianime route on CF Worker forwards to RPI proxy
// RPI uses curl-impersonate to mimic Chrome's TLS handshake

// CF Worker route:
export function getHiAnimeStreamProxyUrl(url: string): string {
  const baseUrl = getCfWorkerBaseUrl();
  return \`\${baseUrl}/hianime/stream?url=\${encodeURIComponent(url)}\`;
}

// RPI proxy uses curl-impersonate-chrome:
// curl_chrome116 --ciphers TLS_AES_128_GCM_SHA256 ...
// This produces a TLS fingerprint identical to Chrome 116`}
              />

              <h3>Extraction Flow</h3>
              <div className={styles.flowContainer}>
                <FlowStep num={1} title="MAL ID Lookup" description="TMDB ID → MAL ID via ARM API (same as AnimeKai)" />
                <FlowStep num={2} title="Search HiAnime" description="Search by MAL title on hianime.to" />
                <FlowStep num={3} title="Episode Resolution" description="Map episode number to HiAnime episode ID" />
                <FlowStep num={4} title="Server Selection" description="Choose MegaCloud server (sub/dub)" />
                <FlowStep num={5} title="CF Worker Extraction" description="Worker handles full extraction pipeline" />
                <FlowStep num={6} title="TLS Bypass" description="CDN requests routed through RPI with curl-impersonate" />
              </div>

              <p>
                HiAnime provides skip intro/outro markers in its metadata, which we pass through to 
                the player for automatic skip functionality.
              </p>

              <blockquote className={styles.quote}>
                <p>
                  &quot;TLS fingerprinting is the most sophisticated anti-bot measure we&apos;ve 
                  encountered. You can fake every HTTP header perfectly, but if your TLS handshake 
                  says &apos;Node.js&apos; instead of &apos;Chrome&apos;, you&apos;re blocked before 
                  the first byte of HTTP is sent. curl-impersonate was the answer.&quot;
                </p>
                <cite>- Field Notes, February 2026</cite>
              </blockquote>
            </motion.div>
          </section>

          {/* VIPRow - NEW */}
          <section id="viprow" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🏟️</span>
                VIPRow - Live Sports Extraction
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Working - Casthill Token Auth + Manifest Rewriting
              </div>
              
              <h3>Overview</h3>
              <p>
                VIPRow provides live sports streams (NBA, NFL, UFC, soccer, etc.) through a complex 
                chain: VIPRow event page → Casthill.net stream extraction → boanki.net token 
                authentication → HLS manifest with encrypted segments.
              </p>

              <h3>Extraction Chain</h3>
              <div className={styles.flowContainer}>
                <FlowStep num={1} title="Event Page" description="Parse VIPRow event page for stream embed URLs" />
                <FlowStep num={2} title="Casthill Extraction" description="Extract stream URL from casthill.net embed" />
                <FlowStep num={3} title="Token Auth" description="Authenticate with boanki.net for stream token" />
                <FlowStep num={4} title="Manifest Rewrite" description="Rewrite m3u8 URLs to route through CF Worker proxy" />
                <FlowStep num={5} title="Key Proxy" description="AES-128 keys proxied through /viprow/key endpoint" />
                <FlowStep num={6} title="Segment Proxy" description="Segments proxied through /viprow/segment endpoint" />
              </div>

              <h3>Required Headers</h3>
              <CodeBlock 
                title="VIPRow/Casthill Required Headers"
                id="viprow-headers"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`// Casthill streams require specific Origin/Referer
const headers = {
  'Origin': 'https://casthill.net',
  'Referer': 'https://casthill.net/',
};

// CF Worker endpoints:
// /viprow/stream   - Extract and proxy the m3u8 manifest
// /viprow/manifest - Refresh manifest during playback
// /viprow/key      - Proxy AES-128 decryption keys
// /viprow/segment  - Proxy video segments`}
              />

              <p>
                VIPRow is registered as a live-sports provider (priority 110) in the Provider Registry. 
                It only activates when <code>metadata.isLive === true</code>. The boanki.net 
                authentication endpoint blocks Cloudflare Worker IPs, so extraction routes through 
                the RPI residential proxy.
              </p>
            </motion.div>
          </section>

          {/* Proxy Architecture */}
          <section id="proxy-architecture" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🔄</span>
                Proxy Architecture
              </h2>
              
              <div className={styles.statusBadge}>
                <span className={styles.statusDot} />
                Production Ready - 3 Layers, Provider-Specific Routing
              </div>
              
              <h3>The Problem</h3>
              <p>
                Multiple CDNs block datacenter IPs, reject requests with Origin headers (which 
                browsers add automatically to XHR), and some even use TLS fingerprinting to detect 
                non-browser clients. Each provider has different CDN requirements.
              </p>

              <h3>Multi-Layer Proxy Solution</h3>
              <div className={styles.architectureDiagram}>
                <div className={styles.archLayer}>
                  <span className={styles.archIcon}>🌐</span>
                  <span>Browser (XHR with Origin)</span>
                </div>
                <div className={styles.archArrow}>↓</div>
                <div className={styles.archLayer}>
                  <span className={styles.archIcon}>▲</span>
                  <span>Next.js API Route</span>
                </div>
                <div className={styles.archArrow}>↓</div>
                <div className={styles.archLayer}>
                  <span className={styles.archIcon}>☁️</span>
                  <span>Cloudflare Worker (provider routing)</span>
                </div>
                <div className={styles.archArrow}>↓</div>
                <div className={styles.archLayer + ' ' + styles.archHighlight}>
                  <span className={styles.archIcon}>🏠</span>
                  <span>Raspberry Pi (Residential IP)</span>
                </div>
                <div className={styles.archArrow}>↓</div>
                <div className={styles.archLayer}>
                  <span className={styles.archIcon}>📺</span>
                  <span>CDN → HLS Stream</span>
                </div>
              </div>

              <h3>Provider-Specific Routes</h3>
              <CodeBlock 
                title="CDN Detection & Routing Logic"
                id="proxy-cdn"
                copiedCode={copiedCode}
                onCopy={copyCode}
                code={`// Each provider has a dedicated CF Worker route:
// /animekai   → RPI /animekai/stream  (MegaUp, VidSrc, VidLink, 1movies CDN)
// /flixer/*   → RPI /flixer/stream    (Flixer CDN: p.XXXXX.workers.dev)
// /hianime    → RPI /hianime/stream   (MegaCloud: TLS fingerprint bypass)
// /viprow/*   → RPI /viprow/stream    (Casthill: boanki.net auth)
// /cdn-live/* → Direct with Referer   (CDN-Live streams)
// /ppv/*      → RPI /ppv/stream       (PPV events)
// /dlhd/*     → Dedicated DLHD Worker (PoW + server-side decryption)

// CDN domain detection:
function isMegaUpCdnUrl(url) {
  const domains = [
    'hub26link.site', 'dev23app.site', 'net22lab.site',
    'pro25zone.site', 'app28base.site', 'megaup.live',
    'rabbitstream', 'vidcloud', 'dokicloud'
  ];
  return domains.some(d => url.includes(d));
}

function is1moviesCdnUrl(url) {
  return url.match(/p\\.\\d+\\.workers\\.dev/);
}`}
              />

              <h3>Why a Raspberry Pi?</h3>
              <p>
                CDNs that block datacenter IPs (Cloudflare, AWS, GCP) cannot block residential IPs 
                without blocking real users. A $35 Raspberry Pi on home internet provides a residential 
                IP that passes all CDN checks. It runs a Node.js proxy with provider-specific endpoints, 
                each with the correct headers and Referer for that provider&apos;s CDN.
              </p>
            </motion.div>
          </section>

          {/* Techniques */}
          <section id="techniques" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🛠️</span>
                Common Techniques
              </h2>
              
              <div className={styles.techniqueGrid}>
                <div className={styles.techniqueCard}>
                  <h4>String Array Obfuscation</h4>
                  <p>Strings stored in array, accessed via index. Array often rotated or encoded.</p>
                  <code>const a = atob(_0x1234[0]);</code>
                </div>
                <div className={styles.techniqueCard}>
                  <h4>Control Flow Flattening</h4>
                  <p>Code restructured into switch inside while loop, hard to follow execution.</p>
                  <code>while(true) switch(state) ...</code>
                </div>
                <div className={styles.techniqueCard}>
                  <h4>XOR Encryption</h4>
                  <p>Each character XORed with key byte. Simple but effective.</p>
                  <code>char ^ key[i % key.length]</code>
                </div>
                <div className={styles.techniqueCard}>
                  <h4>Custom Base64</h4>
                  <p>Standard alphabet shuffled to break decoders.</p>
                  <code>ABCDEFGHIJKLMabc... → shuffled</code>
                </div>
                <div className={styles.techniqueCard}>
                  <h4>Proof-of-Work</h4>
                  <p>Computational challenge to prevent automated requests.</p>
                  <code>MD5(data)[0:4] &lt; threshold</code>
                </div>
                <div className={styles.techniqueCard}>
                  <h4>WASM Encryption</h4>
                  <p>Crypto logic compiled to WebAssembly. Harder to reverse.</p>
                  <code>Rust → WASM → AES-256-CTR</code>
                </div>
                <div className={styles.techniqueCard}>
                  <h4>TLS Fingerprinting</h4>
                  <p>CDN checks TLS handshake to detect non-browser clients.</p>
                  <code>JA3/JA4 → curl-impersonate</code>
                </div>
                <div className={styles.techniqueCard}>
                  <h4>MAC Authentication</h4>
                  <p>IPTV portals use MAC address for device authentication.</p>
                  <code>MAC → Token → Stream URL</code>
                </div>
              </div>
            </motion.div>
          </section>

          {/* Tools */}
          <section id="tools" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🧰</span>
                Tools &amp; Methods
              </h2>
              
              <h3>Essential Tools</h3>
              <div className={styles.toolsGrid}>
                <div className={styles.toolCard}>
                  <div className={styles.toolIcon}>🔍</div>
                  <h4>Browser DevTools</h4>
                  <p>Network tab, Sources debugging, Console testing. Set breakpoints on XHR/fetch.</p>
                </div>
                <div className={styles.toolCard}>
                  <div className={styles.toolIcon}>🧹</div>
                  <h4>de4js</h4>
                  <p>Online JavaScript deobfuscator. Good starting point for most obfuscation.</p>
                </div>
                <div className={styles.toolCard}>
                  <div className={styles.toolIcon}>🔬</div>
                  <h4>Ghidra</h4>
                  <p>NSA&apos;s reverse engineering tool. Essential for WASM binary analysis.</p>
                </div>
                <div className={styles.toolCard}>
                  <div className={styles.toolIcon}>🍳</div>
                  <h4>CyberChef</h4>
                  <p>Swiss army knife for encoding/decoding. Base64, XOR, AES, hex, everything.</p>
                </div>
                <div className={styles.toolCard}>
                  <div className={styles.toolIcon}>🌐</div>
                  <h4>curl-impersonate</h4>
                  <p>Mimics browser TLS fingerprints. Essential for MegaCloud CDN bypass.</p>
                </div>
                <div className={styles.toolCard}>
                  <div className={styles.toolIcon}>🤖</div>
                  <h4>Puppeteer (Research Only)</h4>
                  <p>For initial recon and table extraction. Never used in production—pure HTTP only.</p>
                </div>
              </div>

              <h3>Common Pitfalls</h3>
              <div className={styles.pitfallsList}>
                <div className={styles.pitfall}>
                  <span className={styles.pitfallIcon}>⚠️</span>
                  <strong>Missing Headers</strong> - APIs often require <code>X-Requested-With: XMLHttpRequest</code>
                </div>
                <div className={styles.pitfall}>
                  <span className={styles.pitfallIcon}>⏰</span>
                  <strong>Timestamp Validation</strong> - Some APIs require timestamps in the past (DLHD: 5-10 seconds)
                </div>
                <div className={styles.pitfall}>
                  <span className={styles.pitfallIcon}>🌐</span>
                  <strong>IP Restrictions</strong> - CDNs may block datacenter IPs, need residential proxy
                </div>
                <div className={styles.pitfall}>
                  <span className={styles.pitfallIcon}>🔗</span>
                  <strong>Origin Header</strong> - Browser XHR adds Origin automatically, some CDNs reject it
                </div>
                <div className={styles.pitfall}>
                  <span className={styles.pitfallIcon}>🔒</span>
                  <strong>TLS Fingerprinting</strong> - Some CDNs check TLS handshake, need curl-impersonate
                </div>
                <div className={styles.pitfall}>
                  <span className={styles.pitfallIcon}>☁️</span>
                  <strong>CF Worker → CF Worker</strong> - Cloudflare Workers calling other Workers get blocked by some CDNs
                </div>
              </div>
            </motion.div>
          </section>

          {/* Contributing */}
          <section id="contribute" className={styles.section}>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>🤝</span>
                Contributing
              </h2>
              
              <p>
                Found a new provider? Cracked an obfuscation we haven&apos;t documented? We&apos;d love 
                to hear about it.
              </p>
              
              <h3>What We&apos;re Looking For</h3>
              <div className={styles.contributionList}>
                <div className={styles.contributionItem}>
                  <span>✨</span> New provider extraction methods
                </div>
                <div className={styles.contributionItem}>
                  <span>🔄</span> Updates when providers change their obfuscation
                </div>
                <div className={styles.contributionItem}>
                  <span>🧹</span> Better/cleaner implementations of existing extractors
                </div>
                <div className={styles.contributionItem}>
                  <span>📝</span> Documentation improvements
                </div>
                <div className={styles.contributionItem}>
                  <span>🔓</span> CDN bypass techniques (especially TLS fingerprint solutions)
                </div>
              </div>

              <h3>Guidelines</h3>
              <div className={styles.guidelinesList}>
                <div className={styles.guideline}>
                  <span className={styles.guidelineIcon}>🚫</span>
                  No Puppeteer/browser automation - pure HTTP only
                </div>
                <div className={styles.guideline}>
                  <span className={styles.guidelineIcon}>📖</span>
                  Document your methodology, not just the code
                </div>
                <div className={styles.guideline}>
                  <span className={styles.guidelineIcon}>🔑</span>
                  Include the keys/constants you extracted
                </div>
                <div className={styles.guideline}>
                  <span className={styles.guidelineIcon}>🧪</span>
                  Test with multiple content IDs to ensure reliability
                </div>
                <div className={styles.guideline}>
                  <span className={styles.guidelineIcon}>🏗️</span>
                  Implement the Provider interface for new providers
                </div>
              </div>

              <div className={styles.ctaBox}>
                <p>
                  This documentation is part of the Flyx project. Check out the full{' '}
                  <Link href="/about" className={styles.ctaLink}>About page</Link> for the complete 
                  story of how we built an ethical streaming platform by reverse engineering the 
                  unethical ones.
                </p>
              </div>
            </motion.div>
          </section>

        </main>
      </div>
    </div>
  );
}
