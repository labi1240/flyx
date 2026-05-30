'use client';

import { useEffect } from 'react';

export default function LiveTVError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[LiveTV] Route error:', error);
  }, [error]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      padding: '2rem',
      textAlign: 'center',
      color: '#e4e4e7',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        fontSize: '4rem',
        marginBottom: '1rem',
        color: '#facc15',
      }}>⚡</div>
      <h1 style={{
        fontSize: '1.5rem',
        fontWeight: 600,
        marginBottom: '0.5rem',
      }}>
        Something went wrong
      </h1>
      <p style={{
        fontSize: '0.875rem',
        color: '#a1a1aa',
        maxWidth: '400px',
        marginBottom: '1.5rem',
      }}>
        The Live TV page encountered an error. This is likely due to a temporary issue with our upstream providers.
      </p>
      <button
        onClick={reset}
        style={{
          padding: '0.75rem 1.5rem',
          background: '#facc15',
          color: '#0a0a0f',
          border: 'none',
          borderRadius: '0.5rem',
          fontSize: '0.875rem',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Try Again
      </button>
      {error.digest && (
        <p style={{
          fontSize: '0.75rem',
          color: '#52525b',
          marginTop: '1rem',
          fontFamily: 'monospace',
        }}>
          Error ID: {error.digest}
        </p>
      )}
    </div>
  );
}
