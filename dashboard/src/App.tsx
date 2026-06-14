import { useState } from 'react'
import DailyOverview from './pages/DailyOverview'
import RecipientReport from './pages/RecipientReport'
import SetBreakdown from './pages/SetBreakdown'
import Questions from './pages/Questions'
import './App.css'

type View = 'overview' | 'recipient' | 'breakdown' | 'questions'

export default function App() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [view, setView] = useState<View>('overview')
  const [selectedRecipient, setSelectedRecipient] = useState<{ id: string; name: string } | null>(null)

  function handleSelectRecipient(id: string, name: string) {
    setSelectedRecipient({ id, name })
    setView('recipient')
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>Triarc Site Reports</h1>
        </div>
        <div className="header-right">
          <input
            type="date"
            value={date}
            onChange={e => { setDate(e.target.value); setView('overview') }}
            className="date-input"
          />
        </div>
      </header>

      <nav className="nav">
        <button
          className={view === 'overview' || view === 'recipient' ? 'active' : ''}
          onClick={() => setView('overview')}
        >
          Daily Overview
        </button>
        <button
          className={view === 'breakdown' ? 'active' : ''}
          onClick={() => setView('breakdown')}
        >
          Category Breakdown
        </button>
        <button
          className={view === 'questions' ? 'active' : ''}
          onClick={() => setView('questions')}
        >
          Questions
        </button>
      </nav>

      <main className="main">
        {view === 'overview' && (
          <DailyOverview date={date} onSelectRecipient={handleSelectRecipient} />
        )}
        {view === 'recipient' && selectedRecipient && (
          <>
            <button className="back-btn" onClick={() => setView('overview')}>← Back</button>
            <RecipientReport
              recipient={selectedRecipient.id}
              recipientName={selectedRecipient.name}
              date={date}
            />
          </>
        )}
        {view === 'breakdown' && (
          <SetBreakdown date={date} />
        )}
        {view === 'questions' && (
          <Questions />
        )}
      </main>
    </div>
  )
}
