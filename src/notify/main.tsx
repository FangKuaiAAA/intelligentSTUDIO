import React from 'react'
import { createRoot } from 'react-dom/client'
import NotifyApp from './NotifyApp'
import './notify.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NotifyApp />
  </React.StrictMode>,
)
