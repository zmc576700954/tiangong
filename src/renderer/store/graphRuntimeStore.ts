import { create } from 'zustand'

interface GraphRuntimeState {
  connectingFrom: string | null
  flashedNodeId: string | null
  isZoomedOut: boolean
  zoomLevel: number

  setConnectingFrom: (id: string | null) => void
  flashNode: (id: string) => void
  setZoomLevel: (zoom: number) => void
  setIsZoomedOut: (isZoomedOut: boolean) => void
}

export const useGraphRuntimeStore = create<GraphRuntimeState>((set) => ({
  connectingFrom: null,
  flashedNodeId: null,
  isZoomedOut: false,
  zoomLevel: 1,

  setConnectingFrom: (id) => set({ connectingFrom: id }),
  flashNode: (id) => {
    set({ flashedNodeId: id })
    setTimeout(() => {
      set((s) => (s.flashedNodeId === id ? { flashedNodeId: null } : {}))
    }, 200)
  },
  setZoomLevel: (zoom) => set({ zoomLevel: zoom }),
  setIsZoomedOut: (isZoomedOut) => set({ isZoomedOut }),
}))
