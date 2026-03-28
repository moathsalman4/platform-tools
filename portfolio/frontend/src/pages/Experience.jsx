import { useState, useEffect } from 'react';

function Experience() {
  const [experience, setExperience] = useState([]);

  useEffect(() => {
    fetch('http://localhost:3001/api/experience')
      .then(res => res.json())
      .then(data => setExperience(data));
  }, []);

  return (
    <div className="max-w-5xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Experience</h1>
      {experience.map(job => (
        <div key={job.id} className="mb-8 border-l-2 border-blue-500 pl-6">
          <h2 className="text-xl font-bold">{job.role}</h2>
          <p className="text-gray-400">
            {job.company} — {job.location} ({job.type})
          </p>
          <p className="text-gray-500 text-sm mb-3">
            {job.startDate} → {job.endDate || 'Present'}
          </p>
          <ul className="list-disc list-inside text-gray-300 text-sm space-y-1">
            {job.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 mt-3">
            {job.tags.map(tag => (
              <span key={tag} className="bg-gray-800 text-gray-300 px-2 py-1 rounded text-xs">
                {tag}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Experience;