import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct TalkModeManagerStateTests {
    @Test @MainActor func staleListeningStateResetsBeforeStart() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager._test_markListeningStale()
        #expect(manager.isListening == true)

        manager._test_normalizeListeningStateForStart()
        #expect(manager.isListening == false)
    }
}
