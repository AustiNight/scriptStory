import mammoth from 'mammoth';

/**
 * Parses a file (DOCX, TXT, VTT) and returns its raw text content.
 */
export async function parseDocument(file: File): Promise<string> {
  try {
    // Handle Word Documents
    if (file.name.toLowerCase().endsWith('.docx')) {
      const arrayBuffer = await file.arrayBuffer();
      // mammoth exports a default object in some builds, or named exports in others depending on the CDN.
      // esm.sh usually exports default.
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value;
    } 
    // Handle Text-based formats
    else {
      return await file.text();
    }
  } catch (error) {
    console.error("Error parsing document:", error);
    throw new Error(`Failed to read file: ${file.name}. Ensure it is a valid .docx or text file.`);
  }
}