import { useEffect, useState } from 'react'

// Placeholder shell — Phase 1 replaces this with the real sidebar/chat/settings layout.
// Kept here only to prove the preload/IPC bridge round-trips end to end.
export default function App(): React.JSX.Element {
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null)

  useEffect(() => {
    window.api
      .listSessions()
      .then(() => setBridgeOk(true))
      .catch(() => setBridgeOk(false))
  }, [])

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1>Token Thrift</h1>
      <p>
        IPC bridge:{' '}
        {bridgeOk === null ? 'checking…' : bridgeOk ? 'connected' : 'failed (see console)'}
      </p>
    </div>
  )
}
