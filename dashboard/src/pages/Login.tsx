import { useState, type FormEvent } from 'react'

const CREDENTIALS = {
  email: 'admin@gmail.com',
  password: 'admin123',
}

interface Props {
  onLogin: () => void
}

export default function Login({ onLogin }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    setTimeout(() => {
      if (email === CREDENTIALS.email && password === CREDENTIALS.password) {
        localStorage.setItem('dashboard_auth', '1')
        onLogin()
      } else {
        setError('Invalid email or password.')
        setLoading(false)
      }
    }, 400)
  }

  return (
    <div className="login-bg">
      <div className="login-card">
        <div className="login-logo">🏗️</div>
        <h1 className="login-title">Triarc Site Reports</h1>
        <p className="login-sub">Sign in to access the dashboard</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label className="login-label">Email</label>
            <input
              className="login-input"
              type="email"
              placeholder="admin@gmail.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div className="login-field">
            <label className="login-label">Password</label>
            <input
              className="login-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
