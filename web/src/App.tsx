import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";
import { DashboardPage } from "./pages/DashboardPage";
import { BundlesPage } from "./pages/BundlesPage";
import { InventoryPage } from "./pages/InventoryPage";
import { TransfersPage } from "./pages/TransfersPage";
import { BbsPage } from "./pages/BbsPage";
import { ProcessingPage } from "./pages/ProcessingPage";
import { InstallationsPage } from "./pages/InstallationsPage";
import { CountsPage } from "./pages/CountsPage";
import { TraceabilityPage } from "./pages/TraceabilityPage";
import { MasterDataPage } from "./pages/MasterDataPage";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/accept-invitation" element={<AcceptInvitationPage />} />

          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/bundles" element={<BundlesPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/transfers" element={<TransfersPage />} />
            <Route path="/bbs" element={<BbsPage />} />
            <Route path="/processing" element={<ProcessingPage />} />
            <Route path="/installations" element={<InstallationsPage />} />
            <Route path="/counts" element={<CountsPage />} />
            <Route path="/traceability" element={<TraceabilityPage />} />
            <Route path="/master-data" element={<MasterDataPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
