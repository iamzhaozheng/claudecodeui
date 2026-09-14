import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import { TaskMasterProvider } from './contexts/TaskMasterContext';
import { TasksSettingsProvider } from './contexts/TasksSettingsContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { PluginsProvider } from './contexts/PluginsContext';
import AppContent from './components/app/AppContent';
import GridView from './components/grid/view/GridView';
import { detectRouterBasename } from './utils/routerBasename';
import i18n from './i18n/config.js';

export default function App() {
  const routerBasename = detectRouterBasename();

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AuthProvider>
          <WebSocketProvider>
            <PluginsProvider>
              <TasksSettingsProvider>
                <TaskMasterProvider>
                <ProtectedRoute>
                  <Router basename={routerBasename}>
                    <Routes>
                      <Route path="/" element={<AppContent />} />
                      <Route path="/session/:sessionId" element={<AppContent />} />
                      <Route path="/grid" element={<GridView />} />
                      {/*
                        Grid panes. Same AppContent as the top-level routes —
                        a pane is the whole app, not a cut-down view. The
                        `/embed` prefix is what `isEmbedMode()` keys off.
                      */}
                      <Route path="/embed" element={<AppContent />} />
                      <Route path="/embed/session/:sessionId" element={<AppContent />} />
                    </Routes>
                  </Router>
                </ProtectedRoute>
                </TaskMasterProvider>
              </TasksSettingsProvider>
            </PluginsProvider>
          </WebSocketProvider>
        </AuthProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
