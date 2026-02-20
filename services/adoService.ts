
import { WorkItem, ADOConfig } from '../types';

export const pushToADO = async (config: ADOConfig, item: WorkItem): Promise<number> => {
  // 1. Sanitize and Validate Configuration
  const org = config.organization?.trim();
  const project = config.project?.trim();
  const pat = config.pat?.trim();

  if (!org || !project || !pat) {
    throw new Error("Azure DevOps configuration is missing (Organization, Project, or PAT).");
  }

  // 2. Map internal types to standard ADO Work Item Types
  // NOTE: This defaults to the 'Agile' process template. 
  // If your project uses 'Scrum' (Product Backlog Item) or 'Basic' (Issue), this might need adjustment.
  let adoType = 'User Story';
  switch (item.type) {
    case 'EPIC': adoType = 'Epic'; break;
    case 'FEATURE': adoType = 'Feature'; break;
    case 'STORY': adoType = 'User Story'; break;
    case 'TASK': adoType = 'Task'; break;
    case 'BUG': adoType = 'Bug'; break;
  }

  // 3. Construct the API URL
  // We use encodeURIComponent to safely handle spaces in 'Towne Park Billing'
  const baseUrl = `https://dev.azure.com/${encodeURIComponent(org)}`;
  const projectPath = `${encodeURIComponent(project)}`;
  const workItemPath = `_apis/wit/workitems/$${encodeURIComponent(adoType)}?api-version=7.0`;
  
  const url = `${baseUrl}/${projectPath}/${workItemPath}`;

  // 4. Build JSON Patch Document
  const patchDocument: { op: string; path: string; value: any }[] = [
    { op: "add", path: "/fields/System.Title", value: item.title },
    // ADO requires a string for description, even if empty
    { op: "add", path: "/fields/System.Description", value: item.description || "" },
  ];

  // Map Priority (Text -> Number)
  // "1: Must do" -> 1. Default to 2 if parsing fails.
  const priorityMatch = item.priority ? item.priority.match(/^(\d+)/) : null;
  const priorityVal = priorityMatch ? parseInt(priorityMatch[0]) : 2;
  patchDocument.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: priorityVal });

  // Handle Specialized Fields (Bugs vs Stories)
  if (adoType === 'Bug') {
       let reproHtml = "";
       
       if (item.stepsToReproduce && item.stepsToReproduce.length > 0) {
           reproHtml += "<div><strong>Steps to Reproduce:</strong><ol>";
           item.stepsToReproduce.forEach(step => reproHtml += `<li>${step}</li>`);
           reproHtml += "</ol></div>";
       }

       if (item.expectedResult) {
           reproHtml += `<p><strong>Expected Result:</strong> ${item.expectedResult}</p>`;
       }
       
       if (item.actualResult) {
           reproHtml += `<p><strong>Actual Result:</strong> ${item.actualResult}</p>`;
       }
       
       if (reproHtml) {
           patchDocument.push({ op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: reproHtml });
       }
  } else {
      // Acceptance Criteria for Stories/Features
      if (item.criteria && item.criteria.length > 0) {
          const listHtml = "<ul>" + item.criteria.map(c => `<li>${c.text}</li>`).join('') + "</ul>";
          patchDocument.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: listHtml });
      }
  }

  // Add Tags
  const tags: string[] = [];
  if (item.risk) tags.push(`Risk-${item.risk}`);
  if (item.storyPoints) tags.push(`Points-${item.storyPoints}`);
  
  if (tags.length > 0) {
       patchDocument.push({ op: "add", path: "/fields/System.Tags", value: tags.join(';') });
  }
  
  // Add Story Points
  if (item.storyPoints !== undefined) {
      patchDocument.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: item.storyPoints });
  }

  try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json-patch+json',
          // Basic Auth: Empty username, PAT as password
          'Authorization': `Basic ${btoa(':' + pat)}` 
        },
        body: JSON.stringify(patchDocument)
      });

      if (!response.ok) {
          // Attempt to read the error message from ADO
          const errorText = await response.text().catch(() => "No error details available");
          
          if (response.status === 401) throw new Error("Unauthorized (401). Please check your PAT and Ensure it has 'Work Items (Read & Write)' scope.");
          if (response.status === 404) throw new Error(`Not Found (404). Verify Organization '${org}' and Project '${project}'.`);
          
          throw new Error(`ADO API Error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      return result.id;

  } catch (error: any) {
      // SPECIFIC CORS HANDLING
      if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
          throw new Error(
              `Network Request Blocked (CORS). \n\n` + 
              `The browser blocked the request to '${url}'. \n` +
              `This is a security feature of browsers when calling ADO from a web app. \n\n` + 
              `FIX: Please install a "Allow CORS" browser extension for testing, or run a local proxy.`
          );
      }
      throw error;
  }
};
