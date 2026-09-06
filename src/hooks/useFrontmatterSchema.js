import { useCallback, useState } from 'react';

import { loadFrontmatterSchema, saveFrontmatterSchema } from '../lib/frontmatterSchema.js';

// Same shape as useAccentColor (features/accent/accentColor.js): load once
// from localStorage, keep in state, persist on every change.
function useFrontmatterSchema() {
  const [schema, setSchemaState] = useState(loadFrontmatterSchema);
  const setSchema = useCallback((next) => {
    setSchemaState(next);
    saveFrontmatterSchema(next);
  }, []);
  return [schema, setSchema];
}

export { useFrontmatterSchema };
