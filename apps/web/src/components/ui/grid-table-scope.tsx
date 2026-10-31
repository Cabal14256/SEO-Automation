import { createContext, useContext, type ReactNode } from 'react';

const GridScope = createContext(false);
export function GridTableScope({ children }: { children: ReactNode }) { return <GridScope value={true}>{children}</GridScope>; }
export const useGridTableScope = () => useContext(GridScope);
