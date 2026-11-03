# Implementation Plan: Family Health Manager Transformation

The goal is to transform the existing "Sổ tiết kiệm" (Savings Book) application into a "Family Health Manager" that focuses on digitizing, storing, and tracking health records using Google Drive and Gemini AI.

## 1. Architectural Changes
- **Core Pivot**: Move from managing `SavingsBook` entities to `HealthRecord` and `MemberProfile` entities.
- **Drive Logic**: Update Google Drive service from `fileId` synchronization to `folderId` management.
- **AI Integration**: Integrate Gemini AI (via API) to process images/PDFs of medical records, extract text, and categorize documents into `HealthRecord` objects.

## 2. Phase 1: Cleanup & Foundation
- Remove `SavingsBook` specific UI components, hooks, and utilities.
- Refactor `googleDriveService` to focus on folder traversal and permission management instead of spreadsheet file parsing.
- Update `firestore` schema to track `FolderId` assignments for users instead of individual file links.

## 3. Phase 2: Feature Implementation
- **Member Profiles**: Create a UI for defining/viewing family member profiles and their associated sub-folders in the shared Drive.
- **Digitization Engine**: Implement an upload flow for medical images/PDFs. Use Gemini API to analyze uploaded files, extract key data (date, hospital, type of report), and save to Firestore/Drive.
- **Health Records Dashboard**: Implement a list view for records, filterable by family member and document type.

## 4. Phase 3: AI & Security
- **Data Digitization**: Automate the processing of new uploads using Gemini API for extraction.
- **Access Control**: Ensure the Firestore rule enforces that users can only see records for folders they have been assigned access to in the `FolderId` mapping.

## 5. Technical Requirements
- Continue using Firestore for metadata and user-to-folder mapping.
- Leverage `google-drive` scopes to list folder contents.
- Use `gemini-api` to process medical documentation.
