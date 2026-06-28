'use client';

// Design System Constants and Components
// Provides consistent design patterns across the admin panel

export const DESIGN_TOKENS = {
  colors: {
    primary: '#7877c6',
    primaryGradient: 'linear-gradient(135deg, #7877c6 0%, #9333ea 100%)',
    secondary: '#94a3b8',
    success: '#10b981',
    warning: '#f59e0b',
    danger: '#ef4444',
    info: '#3b82f6',
    
    // Background colors
    background: '#0f172a',
    surface: 'rgba(15, 23, 42, 0.6)',
    surfaceHover: 'rgba(255, 255, 255, 0.05)',
    border: 'rgba(255, 255, 255, 0.1)',
    
    // Text colors
    textPrimary: '#f8fafc',
    textSecondary: '#94a3b8',
    textMuted: '#64748b',
  },
  
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    xxl: '48px',
  },
  
  borderRadius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    xl: '16px',
    full: '9999px',
  },
  
  fontSize: {
    xs: '10px',
    sm: '12px',
    md: '14px',
    lg: '16px',
    xl: '18px',
    xxl: '20px',
    xxxl: '24px',
  },
  
  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  
  shadows: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.05)',
    md: '0 4px 6px rgba(0, 0, 0, 0.1)',
    lg: '0 10px 15px rgba(0, 0, 0, 0.1)',
    xl: '0 20px 25px rgba(0, 0, 0, 0.1)',
  },
  
  breakpoints: {
    mobile: 768,
    tablet: 1024,
    desktop: 1280,
  },
  
  zIndex: {
    dropdown: 1000,
    sticky: 1020,
    fixed: 1030,
    modalBackdrop: 1040,
    modal: 1050,
    popover: 1060,
    tooltip: 1070,
  },
  
  transitions: {
    fast: '0.15s ease',
    normal: '0.2s ease',
    slow: '0.3s ease',
  },
} as const;

// Utility function for responsive design
export const useResponsive = () => {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < DESIGN_TOKENS.breakpoints.mobile;
  const isTablet = typeof window !== 'undefined' && 
    window.innerWidth >= DESIGN_TOKENS.breakpoints.mobile && 
    window.innerWidth < DESIGN_TOKENS.breakpoints.tablet;
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= DESIGN_TOKENS.breakpoints.tablet;
  
  return { isMobile, isTablet, isDesktop };
};

// Common component styles
export const COMPONENT_STYLES = {
  card: {
    background: DESIGN_TOKENS.colors.surface,
    border: `1px solid ${DESIGN_TOKENS.colors.border}`,
    borderRadius: DESIGN_TOKENS.borderRadius.lg,
    padding: DESIGN_TOKENS.spacing.lg,
    WebkitBackdropFilter: 'blur(20px)',
    backdropFilter: 'blur(20px)',
  },
  
  button: {
    base: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: DESIGN_TOKENS.spacing.sm,
      border: 'none',
      borderRadius: DESIGN_TOKENS.borderRadius.md,
      fontWeight: DESIGN_TOKENS.fontWeight.medium,
      cursor: 'pointer',
      transition: DESIGN_TOKENS.transitions.normal,
      outline: 'none',
      minHeight: '40px',
      padding: `${DESIGN_TOKENS.spacing.sm} ${DESIGN_TOKENS.spacing.md}`,
      fontSize: DESIGN_TOKENS.fontSize.md,
    },
    primary: {
      background: DESIGN_TOKENS.colors.primaryGradient,
      color: DESIGN_TOKENS.colors.textPrimary,
      boxShadow: `0 2px 4px rgba(120, 119, 198, 0.2)`,
    },
    secondary: {
      background: DESIGN_TOKENS.colors.surfaceHover,
      color: DESIGN_TOKENS.colors.textPrimary,
      border: `1px solid ${DESIGN_TOKENS.colors.border}`,
    },
  },
  
  input: {
    base: {
      width: '100%',
      padding: `${DESIGN_TOKENS.spacing.md} ${DESIGN_TOKENS.spacing.md}`,
      background: DESIGN_TOKENS.colors.surfaceHover,
      border: `2px solid ${DESIGN_TOKENS.colors.border}`,
      borderRadius: DESIGN_TOKENS.borderRadius.md,
      color: DESIGN_TOKENS.colors.textPrimary,
      fontSize: DESIGN_TOKENS.fontSize.md,
      outline: 'none',
      transition: DESIGN_TOKENS.transitions.normal,
      minHeight: '44px', // Accessibility: minimum touch target
    },
    focused: {
      borderColor: DESIGN_TOKENS.colors.primary,
    },
    error: {
      borderColor: DESIGN_TOKENS.colors.danger,
    },
  },
  
  text: {
    heading1: {
      fontSize: DESIGN_TOKENS.fontSize.xxxl,
      fontWeight: DESIGN_TOKENS.fontWeight.bold,
      color: DESIGN_TOKENS.colors.textPrimary,
      lineHeight: '1.2',
    },
    heading2: {
      fontSize: DESIGN_TOKENS.fontSize.xxl,
      fontWeight: DESIGN_TOKENS.fontWeight.semibold,
      color: DESIGN_TOKENS.colors.textPrimary,
      lineHeight: '1.3',
    },
    heading3: {
      fontSize: DESIGN_TOKENS.fontSize.xl,
      fontWeight: DESIGN_TOKENS.fontWeight.semibold,
      color: DESIGN_TOKENS.colors.textPrimary,
      lineHeight: '1.4',
    },
    body: {
      fontSize: DESIGN_TOKENS.fontSize.md,
      fontWeight: DESIGN_TOKENS.fontWeight.normal,
      color: DESIGN_TOKENS.colors.textSecondary,
      lineHeight: '1.5',
    },
    caption: {
      fontSize: DESIGN_TOKENS.fontSize.sm,
      fontWeight: DESIGN_TOKENS.fontWeight.normal,
      color: DESIGN_TOKENS.colors.textMuted,
      lineHeight: '1.4',
    },
  },
} as const;

// Accessibility helpers
export const ACCESSIBILITY = {
  // Minimum touch target size (44px x 44px)
  minTouchTarget: '44px',
  
  // WCAG color contrast ratios
  contrastRatios: {
    normal: 4.5,
    large: 3.0,
    enhanced: 7.0,
  },
  
  // Screen reader text
  srOnly: {
    position: 'absolute' as const,
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap' as const,
    border: '0',
  },
  
  // Focus styles
  focusRing: {
    outline: `2px solid ${DESIGN_TOKENS.colors.primary}`,
    outlineOffset: '2px',
  },
} as const;

// Animation keyframes
export const ANIMATIONS = {
  spin: `
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `,
  
  pulse: `
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `,
  
  fadeIn: `
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `,
  
  slideIn: `
    @keyframes slideIn {
      from { transform: translateX(-100%); }
      to { transform: translateX(0); }
    }
  `,
  
  slideUp: `
    @keyframes slideUp {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
  `,
} as const;

// Media queries helper
export const mediaQuery = {
  mobile: `@media (max-width: ${DESIGN_TOKENS.breakpoints.mobile - 1}px)`,
  tablet: `@media (min-width: ${DESIGN_TOKENS.breakpoints.mobile}px) and (max-width: ${DESIGN_TOKENS.breakpoints.tablet - 1}px)`,
  desktop: `@media (min-width: ${DESIGN_TOKENS.breakpoints.tablet}px)`,
  largeDesktop: `@media (min-width: ${DESIGN_TOKENS.breakpoints.desktop}px)`,
} as const;