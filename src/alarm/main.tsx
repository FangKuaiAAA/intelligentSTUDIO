import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AlarmApp } from './AlarmApp'
import './alarm.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AlarmApp />
  </StrictMode>,
)
