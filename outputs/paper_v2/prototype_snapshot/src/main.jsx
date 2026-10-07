import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@mui/material/styles'
import { AuthProvider } from './lib/auth'
import App from './App'
import './styles.css'
import theme from './theme'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)
