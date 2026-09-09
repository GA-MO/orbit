const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)'

export const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  ('ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia(COARSE_POINTER_QUERY).matches)
