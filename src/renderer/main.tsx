import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n/I18nProvider'
import './index.css'

const isDev = process.env.NODE_ENV === 'development'
const appElement = (
  <I18nProvider>
    <App />
  </I18nProvider>
)

createRoot(document.getElementById('root')!).render(
  isDev ? appElement : (
    <StrictMode>
      {appElement}
    </StrictMode>
  ),
)
