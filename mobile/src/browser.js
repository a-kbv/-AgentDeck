// Geometry shared by the remote-tab screen and its checks. Points are normalized to the visible image, not the
// whole phone, so letterboxing, a resized viewport, and the soft keyboard never shift a click on the computer.
export function imagePoint(rect, clientX, clientY) {
  if (!rect.width || !rect.height || clientX < rect.left || clientY < rect.top || clientX > rect.right || clientY > rect.bottom) return null;
  return { x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) };
}

export function frameDelay(started, now = Date.now()) { return Math.max(150, 700 - (now - started)); }
