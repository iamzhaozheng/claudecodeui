import { useEffect, useState } from 'react';

import { isEmbedMode } from '../utils/embedMode';

type UseDeviceSettingsOptions = {
  mobileBreakpoint?: number;
  trackMobile?: boolean;
  trackPWA?: boolean;
};

const getIsMobile = (mobileBreakpoint: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  // A grid pane reports its own width, not the window's. Four panes on a 3440px
  // display are ~860px each — above the breakpoint, so the fixed sidebar would
  // stay expanded and eat half of every pane. The drawer layout is what makes a
  // pane usable at that width, so embed mode opts into it regardless of width.
  if (isEmbedMode()) {
    return true;
  }

  return window.innerWidth < mobileBreakpoint;
};

const getIsPWA = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean(navigatorWithStandalone.standalone) ||
    document.referrer.includes('android-app://')
  );
};

export function useDeviceSettings(options: UseDeviceSettingsOptions = {}) {
  const {
    mobileBreakpoint = 768,
    trackMobile = true,
    trackPWA = true
  } = options;

  const [isMobile, setIsMobile] = useState<boolean>(() => (
    trackMobile ? getIsMobile(mobileBreakpoint) : false
  ));
  const [isPWA, setIsPWA] = useState<boolean>(() => (
    trackPWA ? getIsPWA() : false
  ));

  useEffect(() => {
    if (!trackMobile || typeof window === 'undefined') {
      return;
    }

    const checkMobile = () => {
      setIsMobile(getIsMobile(mobileBreakpoint));
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => {
      window.removeEventListener('resize', checkMobile);
    };
  }, [mobileBreakpoint, trackMobile]);

  useEffect(() => {
    if (!trackPWA || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const checkPWA = () => {
      setIsPWA(getIsPWA());
    };

    checkPWA();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', checkPWA);
      return () => {
        mediaQuery.removeEventListener('change', checkPWA);
      };
    }

    mediaQuery.addListener(checkPWA);
    return () => {
      mediaQuery.removeListener(checkPWA);
    };
  }, [trackPWA]);

  return { isMobile, isPWA };
}
