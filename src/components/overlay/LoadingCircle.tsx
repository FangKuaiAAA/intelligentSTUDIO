export function LoadingCircle() {
  return (
    <div className="loading-circle-wrapper">
      <div className="loading-circle">
        <svg width="64" height="64" viewBox="0 0 64 64" className="hexagon-svg">
          <defs>
            <radialGradient id="circleGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.95)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.82)" />
            </radialGradient>
            <linearGradient id="hexGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FF6B9D" />
              <stop offset="25%" stopColor="#C44DFF" />
              <stop offset="50%" stopColor="#4D8AFF" />
              <stop offset="75%" stopColor="#4DFFD9" />
              <stop offset="100%" stopColor="#FFD84D" />
            </linearGradient>
            <filter id="circleShadow">
              <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="rgba(196,77,255,0.3)" />
            </filter>
          </defs>
          <circle cx="32" cy="32" r="30" fill="url(#circleGrad)" filter="url(#circleShadow)" />
          <g style={{ animation: 'hexSpin 6s linear infinite', transformOrigin: '32px 32px' }}>
            <polygon points="32,12 49,22 49,42 32,52 15,42 15,22" fill="url(#hexGrad)" opacity="0.88" />
          </g>
        </svg>
      </div>
    </div>
  )
}
