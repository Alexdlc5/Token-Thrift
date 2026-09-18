interface SpinnerProps {
  size?: number
}

// Keyframes (tt-spin) are defined once in index.html, not per-component — inline style
// objects can't declare @keyframes.
export default function Spinner({ size = 14 }: SpinnerProps): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: '2px solid rgba(255,255,255,0.2)',
        borderTopColor: '#4a9eff',
        borderRadius: '50%',
        animation: 'tt-spin 0.7s linear infinite'
      }}
    />
  )
}
