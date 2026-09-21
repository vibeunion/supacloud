export const page = $state<{ params: { ref: string | undefined } }>({ params: { ref: "a" } });
export const t = {
  subscribe(run: (translate: (key: string) => string) => void) {
    run(key => key);
    return () => {};
  },
};
export async function goto(_path: string): Promise<void> {}
