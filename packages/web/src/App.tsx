import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthContext.js";
import { RequireRole } from "./auth/RequireRole.js";
import type { RuntimeConfig } from "./config.js";
import { AttemptPage } from "./pages/AttemptPage.js";
import { CandidateHomePage } from "./pages/CandidateHomePage.js";
import { GraderAttemptPage } from "./pages/GraderAttemptPage.js";
import { GraderHomePage } from "./pages/GraderHomePage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { SubmittedPage } from "./pages/SubmittedPage.js";

export function App(props: { config: RuntimeConfig }) {
  return (
    <AuthProvider config={props.config}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage userRole="candidate" />} />
          <Route
            path="/exam"
            element={
              <RequireRole userRole="candidate">
                <CandidateHomePage />
              </RequireRole>
            }
          />
          <Route
            path="/exam/:attemptId"
            element={
              <RequireRole userRole="candidate">
                <AttemptPage />
              </RequireRole>
            }
          />
          <Route
            path="/exam/:attemptId/done"
            element={
              <RequireRole userRole="candidate">
                <SubmittedPage />
              </RequireRole>
            }
          />
          <Route path="/grader/login" element={<LoginPage userRole="grader" />} />
          <Route
            path="/grader"
            element={
              <RequireRole userRole="grader">
                <GraderHomePage />
              </RequireRole>
            }
          />
          <Route
            path="/grader/:attemptId"
            element={
              <RequireRole userRole="grader">
                <GraderAttemptPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
