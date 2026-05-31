import GraphDemo from './components/GraphDemo'

function App() {
  return (
    <div className="min-h-screen bg-[#0f1117] text-[#d1d5db]">
      {/* Top bar */}
      <header className="border-b border-[#2a2d36] bg-[#16181f] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-[#3b82f6] flex items-center justify-center text-white font-bold text-sm">
            N
          </div>
          <div>
            <div className="font-semibold">notionLikeObsidian</div>
            <div className="text-[10px] text-[#6b7280] -mt-1">Local Graph for Notion</div>
          </div>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <div className="px-3 py-1 bg-[#0f1117] border border-[#2a2d36] rounded text-xs text-[#6b7280]">
            Option A • Local &amp; Private
          </div>
          <button 
            onClick={() => window.location.reload()} 
            className="btn-secondary px-4 py-1.5 text-xs"
          >
            Reset Demo
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1">
        <GraphDemo />
      </div>

      {/* Footer status */}
      <div className="text-center text-[10px] text-[#6b7280] py-2 border-t border-[#2a2d36]">
        Demo mode — Real Notion connection coming in Fase 1 • See PLAN.md for the full roadmap
      </div>
    </div>
  )
}

export default App
