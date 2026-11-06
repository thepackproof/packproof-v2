import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectApp } from './ConnectApp';
import './styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConnectApp/></React.StrictMode>);
