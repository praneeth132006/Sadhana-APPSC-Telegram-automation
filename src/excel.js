// ============================================
// Excel Service — Reads questions from Excel, writes back "Posted" status
// ============================================
// This module handles all Excel file operations:
// - Reading the config sheet for subject-to-topic mapping
// - Reading questions from per-subject sheets
// - Marking questions as "Posted" directly in the same Excel file
// - Reading schedule config from the config sheet
//
// Excel file structure:
//   Sheet "Config"    → subject names, emojis, topic_thread_ids, schedule settings
//   Sheet "Polity"    → questions for Polity subject
//   Sheet "Economy"   → questions for Economy subject
//   ... one sheet per subject
//
// Each subject sheet has columns:
//   Question | Option A | Option B | Option C | Option D | Correct Answer | Explanation | Posted
//
// The "Posted" column is updated to "YES" + timestamp after posting to Telegram.

const XLSX = require('xlsx'); // SheetJS library for reading and writing Excel files
const path = require('path'); // Node.js path module for file path operations

// Default path to the main questions Excel file — lives in the project root
const DEFAULT_EXCEL_PATH = path.join(__dirname, '..', 'questions.xlsx');

// Default path to the config Excel file — holds subject→topic mapping and schedule settings
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.xlsx');

/**
 * readConfig — Reads the config.xlsx file to get subject-to-topic mapping and schedule info.
 * 
 * Config sheet columns:
 *   Subject | Emoji | Topic_Thread_ID | Schedule_Cron | Questions_Per_Batch | Active
 *
 * @param {string} [configPath] — Optional custom path to config.xlsx
 * @returns {Array<Object>} Array of config objects, one per subject
 */
function readConfig(configPath = DEFAULT_CONFIG_PATH) {
  // Read the config workbook from disk
  const workbook = XLSX.readFile(configPath);

  // Get the first sheet (should be "Config")
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Convert the sheet data to JSON array — each row becomes an object
  // defval: '' ensures empty cells get an empty string instead of undefined
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  // Map each row to a clean config object with normalized field names
  const config = rows.map(row => ({
    subject: String(row['Subject'] || '').trim(),                         // Subject name — must match a sheet name in questions.xlsx
    emoji: String(row['Emoji'] || '📚').trim(),                           // Emoji icon for the Telegram topic
    topic_thread_id: row['Topic_Thread_ID'] ? Number(row['Topic_Thread_ID']) : null, // Telegram forum topic thread ID
    schedule_cron: String(row['Schedule_Cron'] || '').trim(),             // Cron expression for auto-posting (e.g., "0 */2 * * *")
    questions_per_batch: Number(row['Questions_Per_Batch']) || 5,          // How many questions to post per batch
    active: String(row['Active'] || 'YES').trim().toUpperCase() === 'YES' // Whether this subject's schedule is active
  }));

  // Filter out rows that don't have a subject name (empty rows)
  return config.filter(c => c.subject);
}

/**
 * writeConfig — Writes updated config data back to config.xlsx.
 * Used after setup.js creates Telegram topics and needs to save the topic_thread_ids.
 *
 * @param {Array<Object>} configData — Array of config objects to write
 * @param {string} [configPath] — Optional custom path to config.xlsx
 */
function writeConfig(configData, configPath = DEFAULT_CONFIG_PATH) {
  // Convert config objects to rows with the expected column names
  const rows = configData.map(c => ({
    'Subject': c.subject,
    'Emoji': c.emoji,
    'Topic_Thread_ID': c.topic_thread_id || '',
    'Schedule_Cron': c.schedule_cron,
    'Questions_Per_Batch': c.questions_per_batch,
    'Active': c.active ? 'YES' : 'NO'
  }));

  // Create a new workbook and worksheet from the data
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);

  // Set column widths for readability when opened in Excel
  worksheet['!cols'] = [
    { wch: 20 },  // Subject
    { wch: 8 },   // Emoji
    { wch: 18 },  // Topic_Thread_ID
    { wch: 20 },  // Schedule_Cron
    { wch: 22 },  // Questions_Per_Batch
    { wch: 8 }    // Active
  ];

  // Add the worksheet to the workbook with sheet name "Config"
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Config');

  // Write the workbook to disk — overwrites the existing file
  XLSX.writeFile(workbook, configPath);

  // Log confirmation
  console.log(`✅ Config saved to: ${configPath}`);
}

/**
 * getUnpostedQuestions — Reads a subject's sheet and returns questions not yet posted.
 * Looks for rows where the "Posted" column is empty or not "YES".
 *
 * @param {string} subject — The sheet name (subject) to read from
 * @param {number} [count] — Maximum number of unposted questions to return (default: all)
 * @param {string} [excelPath] — Optional custom path to questions.xlsx
 * @returns {Array<Object>} Array of question objects with row numbers for tracking
 */
function getUnpostedQuestions(subject, count = Infinity, excelPath = DEFAULT_EXCEL_PATH) {
  // Read the questions workbook
  const workbook = XLSX.readFile(excelPath);

  // Check if a sheet with this subject name exists
  if (!workbook.SheetNames.includes(subject)) {
    console.error(`❌ Sheet "${subject}" not found in ${excelPath}`);
    console.log(`   Available sheets: ${workbook.SheetNames.join(', ')}`);
    return [];
  }

  // Get the subject's worksheet
  const worksheet = workbook.Sheets[subject];

  // Convert to JSON array — each row becomes an object keyed by column headers
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  // Filter to only unposted questions (where "Posted" column is empty or not "YES")
  const unposted = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Check if this question has already been posted
    const postedValue = String(row['Posted'] || '').trim().toUpperCase();
    if (postedValue === 'YES' || postedValue.startsWith('YES')) {
      continue; // Skip already-posted questions
    }

    // Validate that the row has the required data
    const question = String(row['Question'] || '').trim();
    const optionA = String(row['Option A'] || '').trim();
    const optionB = String(row['Option B'] || '').trim();
    const optionC = String(row['Option C'] || '').trim();
    const optionD = String(row['Option D'] || '').trim();
    const correctAnswer = String(row['Correct Answer'] || '').trim().toUpperCase();

    // Skip rows with missing required fields
    if (!question || !optionA || !optionB || !optionC || !optionD) {
      continue;
    }

    // Skip rows with invalid correct answer
    if (!['A', 'B', 'C', 'D'].includes(correctAnswer)) {
      console.warn(`⚠️  Row ${i + 2} in "${subject}": Invalid correct answer "${correctAnswer}", skipping`);
      continue;
    }

    // Build the question object
    unposted.push({
      question_text: question,
      option_a: optionA,
      option_b: optionB,
      option_c: optionC,
      option_d: optionD,
      correct_answer: correctAnswer,
      explanation: String(row['Explanation'] || '').trim(),
      date: String(row['Date'] || '').trim(),
      newspaper: String(row['Newspaper'] || '').trim(),
      topic: String(row['Topic'] || '').trim(),
      row_index: i,           // 0-based index in the data array (for writing back)
      excel_row: i + 2         // 1-based Excel row number (row 1 = headers, row 2 = first data)
    });

    // Stop if we've collected enough questions
    if (unposted.length >= count) {
      break;
    }
  }

  return unposted;
}

/**
 * markAsPosted — Updates the "Posted" column for specific rows in the Excel file.
 * Writes "YES | <timestamp>" so you can see exactly when each question was posted.
 *
 * @param {string} subject — The sheet name (subject) to update
 * @param {Array<number>} rowIndices — 1-based Excel row numbers (2 = first data row)
 * @param {string} [excelPath] — Optional custom path to questions.xlsx
 */
function markAsPosted(subject, rowIndices, excelPath = DEFAULT_EXCEL_PATH) {
  // Read the workbook fresh (in case it was modified externally)
  const workbook = XLSX.readFile(excelPath);

  // Get the subject's worksheet
  const worksheet = workbook.Sheets[subject];

  // Convert to JSON to work with the data
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  // Get the current timestamp in IST (Indian Standard Time) for the "Posted" column
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // Update the "Posted" column for each specified row.
  // Row numbers are 1-based with row 1 as the header, so data starts at 2. This
  // used to guess between a 0-based index and a row number based on the sheet's
  // length, which marked the wrong rows whenever the batch fitted inside the
  // sheet — questions went out and still looked unposted afterwards.
  for (const rowNumber of rowIndices) {
    const index = Number(rowNumber) - 2; // 0-based position in the data array

    if (Number.isInteger(index) && index >= 0 && index < rows.length) {
      rows[index]['Posted'] = `YES | ${timestamp}`; // Mark as posted with IST timestamp
    }
  }

  // Convert the updated data back to a worksheet
  const updatedWorksheet = XLSX.utils.json_to_sheet(rows);

  // Set column widths for readability
  updatedWorksheet['!cols'] = [
    { wch: 60 },  // Question
    { wch: 30 },  // Option A
    { wch: 30 },  // Option B
    { wch: 30 },  // Option C
    { wch: 30 },  // Option D
    { wch: 15 },  // Correct Answer
    { wch: 50 },  // Explanation
    { wch: 30 }   // Posted
  ];

  // Replace the old worksheet with the updated one in the workbook
  workbook.Sheets[subject] = updatedWorksheet;

  // Write the updated workbook back to disk
  XLSX.writeFile(workbook, excelPath);

  // Log what was updated
  console.log(`📝 Marked ${rowIndices.length} question(s) as posted in sheet "${subject}"`);
}

/**
 * getStats — Returns a summary of question counts per subject (total, posted, pending).
 *
 * @param {Array<string>} subjects — Array of subject/sheet names to check
 * @param {string} [excelPath] — Optional custom path to questions.xlsx
 * @returns {Array<Object>} Array of { subject, total, posted, pending } objects
 */
function getStats(subjects, excelPath = DEFAULT_EXCEL_PATH) {
  // Read the workbook once
  const workbook = XLSX.readFile(excelPath);
  const stats = [];

  for (const subject of subjects) {
    // Skip if sheet doesn't exist
    if (!workbook.SheetNames.includes(subject)) {
      stats.push({ subject, total: 0, posted: 0, pending: 0, error: 'Sheet not found' });
      continue;
    }

    const worksheet = workbook.Sheets[subject];
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

    // Count posted vs unposted questions
    let posted = 0;
    let total = 0;

    for (const row of rows) {
      // Only count rows that have a question (skip empty rows)
      if (String(row['Question'] || '').trim()) {
        total++;
        const postedValue = String(row['Posted'] || '').trim().toUpperCase();
        if (postedValue === 'YES' || postedValue.startsWith('YES')) {
          posted++;
        }
      }
    }

    stats.push({ subject, total, posted, pending: total - posted });
  }

  return stats;
}

/**
 * listSheets — Returns all sheet names from the questions Excel file.
 * Useful for discovering which subjects are available.
 *
 * @param {string} [excelPath] — Optional custom path to questions.xlsx
 * @returns {Array<string>} Array of sheet names
 */
function listSheets(excelPath = DEFAULT_EXCEL_PATH) {
  const workbook = XLSX.readFile(excelPath);
  return workbook.SheetNames;
}

// Export all functions for use by other modules
module.exports = {
  readConfig,
  writeConfig,
  getUnpostedQuestions,
  markAsPosted,
  getStats,
  listSheets,
  DEFAULT_EXCEL_PATH,
  DEFAULT_CONFIG_PATH
};
