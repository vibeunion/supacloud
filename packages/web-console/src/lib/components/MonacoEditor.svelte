<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type * as Monaco from 'monaco-editor';

  let { value = $bindable(), language = 'sql', theme = 'vs-dark' } = $props();
  
  let editorContainer: HTMLDivElement;
  let editor: Monaco.editor.IStandaloneCodeEditor;
  let monaco: typeof Monaco;

  onMount(async () => {
    monaco = await import('monaco-editor');
    
    editor = monaco.editor.create(editorContainer, {
      value,
      language,
      theme,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineNumbers: 'on',
      padding: { top: 10, bottom: 10 }
    });

    editor.onDidChangeModelContent(() => {
      value = editor.getValue();
    });
  });

  $effect(() => {
    if (editor && value !== editor.getValue()) {
      editor.setValue(value);
    }
  });

  onDestroy(() => {
    if (editor) {
      editor.dispose();
    }
  });
</script>

<div bind:this={editorContainer} class="w-full h-full"></div>
