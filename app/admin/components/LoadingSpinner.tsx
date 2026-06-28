'use client';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  color?: string;
  message?: string;
  fullScreen?: boolean;
}

export default function LoadingSpinner({ 
  size = 'md', 
  color = '#7877c6', 
  message,
  fullScreen = false 
}: LoadingSpinnerProps) {
  const sizeMap = {
    sm: 16,
    md: 24,
    lg: 32,
  };

  const spinnerSize = sizeMap[size];

  const spinner = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
      }}
      role="status"
      aria-live="polite"
      aria-label={message || 'Loading'}
    >
      <div
        style={{
          width: `${spinnerSize}px`,
          height: `${spinnerSize}px`,
          border: `2px solid rgba(255, 255, 255, 0.1)`,
          borderTop: `2px solid ${color}`,
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }}
        aria-hidden="true"
      />
      {message && (
        <span
          style={{
            color: '#94a3b8',
            fontSize: '14px',
            textAlign: 'center',
          }}
        >
          {message}
        </span>
      )}
      
      <style jsx>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );

  if (fullScreen) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(15, 23, 42, 0.8)',
          WebkitBackdropFilter: 'blur(4px)',
          backdropFilter: 'blur(4px)',
          zIndex: 9999,
        }}
        aria-modal="true"
      >
        {spinner}
      </div>
    );
  }

  return spinner;
}