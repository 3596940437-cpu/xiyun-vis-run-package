import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

document.documentElement.lang = 'zh-CN';
document.documentElement.translate = false;
document.documentElement.classList.add('notranslate');
document.body.translate = false;
document.body.classList.add('notranslate');

const rootElement = document.getElementById('root')!;
rootElement.translate = false;
rootElement.classList.add('notranslate');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
