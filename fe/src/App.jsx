import { BrowserRouter, Routes, Route } from "react-router-dom"
import InboxPage from "./pages/InboxPage"
import CaseDetailPage from "./pages/CaseDetailPage"

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InboxPage />} />
        <Route path="/case/:studentId" element={<CaseDetailPage />} />
      </Routes>
    </BrowserRouter>
  )
}
