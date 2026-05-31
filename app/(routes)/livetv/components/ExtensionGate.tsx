/**
 * ExtensionGate — Hard gate requiring Flyx Bypass extension for Live TV
 *
 * DLHD media tokens are IP-bound to the browser that fetches daddy.php.
 * Without the extension minting the signed stream from the user's residential IP,
 * every media playlist fetch from the CF Worker datacenter IP gets 403'd.
 * The extension is the ONLY way to make DLHD Live TV work.
 */

'use client';

import { useState, useEffect } from 'react';
import { useExtensionDetected } from '@/hooks/useExtensionDetected';
import styles from './ExtensionGate.module.css';

const GITHUB_RELEASES = 'https://github.com/Vynx-Velvet/Flyx-main/releases';
const EXTENSION_VERSION = '2.1.0';

// Detect browser for tailored instructions
function getBrowser(): 'chrome' | 'firefox' | 'edge' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg')) return 'edge';
  if (ua.includes('Chrome') || ua.includes('Chromium')) return 'chrome';
  return 'other';
}

const BROWSER_NAMES: Record<string, string> = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  edge: 'Edge',
  other: 'Chromium-based browser (Chrome, Edge, Brave, etc.)',
};

const STEPS: Record<string, Array<{ title: string; detail: string }>> = {
  chrome: [
    {
      title: 'Download the extension',
      detail: `Go to the GitHub Releases page and download the latest \`flyx-bypass-v${EXTENSION_VERSION}.zip\` file from the assets section.`,
    },
    {
      title: 'Unzip the extension',
      detail: 'Extract the downloaded ZIP file to a permanent folder on your computer (e.g., `Documents\\FlyxBypass`). Do NOT delete this folder — Chrome needs it to keep the extension loaded.',
    },
    {
      title: 'Open Chrome Extensions page',
      detail: 'Go to `chrome://extensions/` in your address bar, or click the puzzle icon 🧩 in the toolbar → "Manage extensions".',
    },
    {
      title: 'Enable Developer Mode',
      detail: 'Toggle the "Developer mode" switch in the top-right corner of the extensions page.',
    },
    {
      title: 'Load the extension',
      detail: 'Click "Load unpacked" and select the folder where you extracted the ZIP file.',
    },
    {
      title: 'Pin the extension (optional)',
      detail: 'Click the puzzle icon 🧩, find "Flyx Bypass" in the list, and click the pin 📌 icon so you can see its status at a glance.',
    },
    {
      title: 'Refresh this page',
      detail: 'Once the extension is loaded, refresh this page. The gate will unlock automatically.',
    },
  ],
  edge: [
    {
      title: 'Download the extension',
      detail: `Go to the GitHub Releases page and download the latest \`flyx-bypass-v${EXTENSION_VERSION}.zip\` file.`,
    },
    {
      title: 'Unzip the extension',
      detail: 'Extract the downloaded ZIP file to a permanent folder on your computer. Do NOT delete this folder.',
    },
    {
      title: 'Open Edge Extensions page',
      detail: 'Go to `edge://extensions/` in your address bar.',
    },
    {
      title: 'Enable Developer Mode',
      detail: 'Toggle the "Developer mode" switch in the bottom-left sidebar.',
    },
    {
      title: 'Load the extension',
      detail: 'Click "Load unpacked" and select the folder where you extracted the ZIP file.',
    },
    {
      title: 'Refresh this page',
      detail: 'Once the extension is loaded, refresh this page. The gate will unlock automatically.',
    },
  ],
  firefox: [
    {
      title: 'Download the extension',
      detail: `Go to the GitHub Releases page and download the latest \`flyx-bypass-v${EXTENSION_VERSION}.zip\` file.`,
    },
    {
      title: 'Unzip the extension',
      detail: 'Extract the downloaded ZIP file to a permanent folder on your computer. Do NOT delete this folder.',
    },
    {
      title: 'Open Firefox Debugging page',
      detail: 'Go to `about:debugging#/runtime/this-firefox` in your address bar.',
    },
    {
      title: 'Load the extension',
      detail: 'Click "Load Temporary Add-on…" and select the `manifest.json` file inside the extracted folder.',
    },
    {
      title: 'Note: Temporary add-on',
      detail: 'Firefox temporary add-ons are removed when you restart the browser. For permanent installation, the extension will need to be signed by Mozilla.',
    },
    {
      title: 'Refresh this page',
      detail: 'Once the extension is loaded, refresh this page. The gate will unlock automatically.',
    },
  ],
  other: [
    {
      title: 'Download the extension',
      detail: `Go to the GitHub Releases page and download the latest \`flyx-bypass-v${EXTENSION_VERSION}.zip\` file.`,
    },
    {
      title: 'Unzip the extension',
      detail: 'Extract the downloaded ZIP file to a permanent folder on your computer. Do NOT delete this folder.',
    },
    {
      title: 'Open your browser\'s Extensions page',
      detail: 'Navigate to your browser\'s extension management page (usually `chrome://extensions/`, `edge://extensions/`, or `brave://extensions/`).',
    },
    {
      title: 'Enable Developer Mode',
      detail: 'Look for a "Developer mode" toggle and turn it on.',
    },
    {
      title: 'Load the extension',
      detail: 'Click "Load unpacked" and select the folder where you extracted the ZIP file.',
    },
    {
      title: 'Refresh this page',
      detail: 'Once the extension is loaded, refresh this page. The gate will unlock automatically.',
    },
  ],
};

export function ExtensionGate({ children }: { children: React.ReactNode }) {
  const { detected, version, checking, recheck } = useExtensionDetected();
  const [browser, setBrowser] = useState<string>('other');
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    setBrowser(getBrowser());
  }, []);

  const handleRecheck = async () => {
    setRechecking(true);
    // Small delay so user sees the spinner
    await new Promise((r) => setTimeout(r, 600));
    recheck();
    setRechecking(false);
  };

  // Still checking — show nothing (avoids flash of gate on extension users)
  if (checking) {
    return (
      <div className={styles.checking}>
        <div className={styles.spinner} />
        <p>Checking extension…</p>
      </div>
    );
  }

  // Extension detected — render children
  if (detected) {
    return <>{children}</>;
  }

  // No extension — show the gate
  const steps = STEPS[browser] || STEPS.other;
  const browserName = BROWSER_NAMES[browser] || BROWSER_NAMES.other;

  return (
    <div className={styles.gate}>
      <div className={styles.gateCard}>
        {/* Header */}
        <div className={styles.gateHeader}>
          <div className={styles.gateIcon}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" strokeLinecap="round" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" strokeLinecap="round" />
              <circle cx="12" cy="16" r="1" fill="currentColor" />
            </svg>
          </div>
          <h2 className={styles.gateTitle}>Extension Required</h2>
          <p className={styles.gateSubtitle}>
            Live TV channels use <strong>IP-bound streaming</strong> — a security measure that
            ties every viewer&apos;s access key to their unique internet address. Our servers
            can&apos;t unlock these streams for you from a datacenter. The extension lets{' '}
            <strong>your own device</strong> handle the unlock step, right from your home connection.
          </p>
        </div>

        {/* Why — layman-friendly explanation */}
        <div className={styles.whySection}>
          <h3>🧠 Why do I need this? (Plain English)</h3>
          <p>
            Imagine you&apos;re picking up concert tickets at a <strong>will-call booth</strong>.
            The venue has a strict rule:{' '}
            <em>&ldquo;We only hand tickets to the person whose name is on the order. Show us your ID.&rdquo;</em>
          </p>
          <p>
            That&apos;s exactly how Live TV streams work. When you click play, the stream
            source says:{' '}
            <em>&ldquo;Sure, here&apos;s your access key — but I&apos;m stamping it with{' '}
              <strong>your</strong> IP address. Only that IP can use it.&rdquo;</em>
          </p>
          <p>
            Here&apos;s the problem: <strong>our website doesn&apos;t live at your house.</strong> It runs on
            servers in a datacenter somewhere. If our server tries to pick up the
            ticket for you, the key gets stamped with the <strong>datacenter&apos;s IP</strong> —
            not yours. When your browser then tries to use that key, the stream
            source checks the stamp, sees a mismatch, and says:{' '}
            <em>&ldquo;Sorry, this key wasn&apos;t issued to you. Access denied.&rdquo;</em> (That&apos;s the
            dreaded <strong>403 Forbidden</strong> error.)
          </p>
          <p>
            <strong>The extension fixes this</strong> by having{' '}
            <strong>your browser</strong> — running on <strong>your device</strong>, on{' '}
            <strong>your home internet</strong> — pick up the ticket directly.
            The key gets stamped with <strong>your IP</strong>, your browser uses it,
            the stamps match, and the stream plays. ✅
          </p>
          <p className={styles.whyPrivacy}>
            🔒 <strong>Privacy:</strong> The extension doesn&apos;t track you, doesn&apos;t show ads,
            and doesn&apos;t collect any data. It&apos;s open-source (you can read every line of code).
            Its <em>only</em> job is to fetch stream keys from your connection instead of ours.
          </p>
        </div>

        {/* Steps */}
        <div className={styles.stepsSection}>
          <h3>
            Installation Guide
            <span className={styles.browserBadge}>{browserName}</span>
          </h3>
          <ol className={styles.stepsList}>
            {steps.map((step, i) => (
              <li key={i} className={styles.step}>
                <div className={styles.stepNumber}>{i + 1}</div>
                <div className={styles.stepContent}>
                  <h4>{step.title}</h4>
                  <p>{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Actions */}
        <div className={styles.gateActions}>
          <a
            href={GITHUB_RELEASES}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.primaryButton}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Download from GitHub Releases
          </a>

          <button
            onClick={handleRecheck}
            className={styles.secondaryButton}
            disabled={rechecking}
          >
            {rechecking ? (
              <>
                <div className={styles.spinnerSmall} />
                Checking…
              </>
            ) : (
              'I\'ve installed it — Check Again'
            )}
          </button>
        </div>

        {/* Footer */}
        <p className={styles.gateFooter}>
          Version {EXTENSION_VERSION} · Open source · No ads, no data collection
          {version && ` · Detected: v${version}`}
        </p>
      </div>
    </div>
  );
}
