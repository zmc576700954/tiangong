import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const isDev = process.env.NODE_ENV === 'development'
const appElement = <App />

createRoot(document.getElementById('root')!).render(
  isDev ? appElement : (
    <StrictMode>
      {appElement}
    </StrictMode>
  ),
)
